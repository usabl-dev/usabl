/**
 * The tree a receipt binds and the list of changed files come from the bytes on disk, the bytes
 * the dev server serves and the checks read. A setting or an attribute the agent can write from
 * inside the repository never makes an edited file read unchanged: not a filter, not ident, not
 * working-tree-encoding, not the index's saved file info, not an fsmonitor hook, not a replace
 * ref, not a graft. A repository whose filters are honest (LFS, line endings) still reads an
 * unchanged file as unchanged, with a tree that stays the same from one read to the next.
 *
 * Real git in a temporary folder, with a global config of the test's own, so the developer's
 * global config (which may define a real LFS filter) never changes the result.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeGitReader } from '../../src/deps/git.js';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

const execFileAsync = promisify(execFile);
const posixOnly = process.platform === 'win32' ? it.skip : it;

let repo = '';
let home = '';
const savedEnv: Record<string, string | undefined> = {};

async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

async function git(...args: string[]): Promise<string> {
  return gitIn(repo, ...args);
}

async function write(path: string, text: string | Buffer, base: string = repo): Promise<void> {
  await mkdir(join(base, path, '..'), { recursive: true });
  await writeFile(join(base, path), text);
}

async function script(name: string, body: string): Promise<string> {
  const path = join(home, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function paths(cwd: string = repo): Promise<string[]> {
  return (await makeGitReader({ cwd }).statusZ()).map((entry) => entry.path).sort();
}

async function tree(cwd: string = repo): Promise<string> {
  return makeGitReader({ cwd }).writeTree();
}

async function newRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await gitIn(path, 'init', '-q', '--initial-branch=main');
  await gitIn(path, 'config', 'user.name', 'Test User');
  await gitIn(path, 'config', 'user.email', 'test@example.invalid');
}

async function commitAll(message = 'commit', cwd: string = repo): Promise<void> {
  await gitIn(cwd, 'add', '-A');
  await gitIn(cwd, 'commit', '-q', '-m', message);
}

// The committed screen. On disk the label element is what the checks read.
const APP = 'export const App = () => <label htmlFor="n">Name</label>;\n';
const LABEL = '<label htmlFor="n">Name</label>';
// The same size as APP, with the label gone.
const APP_EDITED = APP.replace(LABEL, `<b>${'x'.repeat(LABEL.length - 7)}</b>`);

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'usabl-raw-bytes-home-')));
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    savedEnv[key] = process.env[key];
  }
  await writeFile(join(home, 'gitconfig'), '[core]\n\thooksPath = /dev/null\n');
  process.env['GIT_CONFIG_GLOBAL'] = join(home, 'gitconfig');
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  repo = await realpath(await mkdtemp(join(tmpdir(), 'usabl-raw-bytes-')));
  await newRepo(repo);
  await write('src/App.tsx', APP);
  await write('src/Other.tsx', 'export const Other = 1;\n');
  await commitAll('base');
  expect(APP_EDITED.length).toBe(APP.length);
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('edits that local git settings hide are still read', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  posixOnly('reads a same-size edit under a clean filter from the local config', async () => {
    const before = await tree();
    const hide = await script('hide.sh', 'git cat-file blob "HEAD:$1"');
    await git('config', 'filter.hide.clean', `${hide} %f`);
    await write('.git/info/attributes', 'src/App.tsx filter=hide\n');
    await write('src/App.tsx', APP_EDITED);
    // git itself sees nothing.
    expect(await git('status', '--porcelain')).toBe('');
    expect(await paths()).toEqual(['src/App.tsx']);
    expect(await tree()).not.toBe(before);
  });

  it('reads a same-size edit inside an $Id$ marker under ident in .git/info/attributes', async () => {
    await write('src/App.tsx', 'export const App = "$Id$<label>Name</label>";\n');
    await commitAll('marker');
    await write('.git/info/attributes', '*.tsx ident\n');
    await rm(join(repo, 'src/App.tsx'));
    await git('checkout', '--', 'src/App.tsx');
    const expanded = await readFile(join(repo, 'src/App.tsx'), 'utf8');
    expect(expanded).toMatch(/\$Id: [0-9a-f]{40} \$/u);
    const before = await tree();
    expect(await paths()).toEqual([]);
    const marker = /\$Id: [0-9a-f]{40} \$/u.exec(expanded)?.[0] ?? '';
    const payload = '$Id: "/><b>injected</b><i a="x ';
    await write('src/App.tsx', expanded.replace(marker, `${payload}${'_'.repeat(marker.length - payload.length - 1)}$`));
    expect(await git('status', '--porcelain')).toBe('');
    expect(await paths()).toEqual(['src/App.tsx']);
    expect(await tree()).not.toBe(before);
  });

  it('reads an edit that working-tree-encoding in .git/info/attributes turns back into the committed text', async () => {
    await write('src/App.tsx', "export const App = '<label for=\"n\">Name</label>';\n");
    await commitAll('single quotes');
    const before = await tree();
    await write('.git/info/attributes', 'src/App.tsx working-tree-encoding=UTF-7\n');
    // In UTF-7, +ADw- is <. On disk the page holds text where the commit has a label element.
    await write('src/App.tsx', "export const App = '+ADw-label for=\"n\"+AD4-Name+ADw-/label+AD4-';\n");
    expect(await paths()).toEqual(['src/App.tsx']);
    expect(await tree()).not.toBe(before);
  });

  it('reads a same-size edit with its modification time restored when core.trustctime is false', async () => {
    await git('config', 'core.trustctime', 'false');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await git('status', '--porcelain');
    const { mtime } = await stat(join(repo, 'src/App.tsx'));
    await write('src/App.tsx', APP_EDITED);
    await utimes(join(repo, 'src/App.tsx'), mtime, mtime);
    expect(await git('status', '--porcelain')).toBe('');
    expect(await paths()).toEqual(['src/App.tsx']);
  });

  posixOnly('reads an edit that an fsmonitor hook says did not happen', async () => {
    const hook = await script('fsmonitor.sh', 'printf "token\\0"');
    await git('config', 'core.fsmonitor', hook);
    await git('status', '--porcelain');
    await write('src/App.tsx', 'export const App = () => <b>longer and without a label</b>;\n');
    expect(await git('status', '--porcelain')).toBe('');
    expect(await paths()).toEqual(['src/App.tsx']);
  });

  it('reads a staged edit when a replace ref swaps the HEAD tree for one that holds it', async () => {
    await write('src/App.tsx', APP_EDITED);
    await git('add', 'src/App.tsx');
    const withEdit = (await git('write-tree')).trim();
    await git('replace', (await git('rev-parse', 'HEAD^{tree}')).trim(), withEdit);
    expect(await git('status', '--porcelain')).toBe('');
    expect(await paths()).toEqual(['src/App.tsx']);
  });

  it('reads the committed text at a ref when a replace ref swaps its blob', async () => {
    const id = (await git('rev-parse', 'HEAD:src/App.tsx')).trim();
    await write('weaker.txt', 'weaker policy\n');
    const weaker = (await git('hash-object', '-w', 'weaker.txt')).trim();
    await git('replace', id, weaker);
    expect(await git('cat-file', 'blob', `HEAD:src/App.tsx`)).toBe('weaker policy\n');
    expect(await makeGitReader({ cwd: repo }).show('HEAD', 'src/App.tsx')).toBe(APP);
  });

  it('lists a committed edit when a graft makes HEAD a parent of the trusted commit', async () => {
    const trusted = (await git('rev-parse', 'HEAD')).trim();
    await git('branch', 'trusted');
    await write('src/App.tsx', APP_EDITED);
    await commitAll('edit');
    const head = (await git('rev-parse', 'HEAD')).trim();
    await write('.git/info/grafts', `${trusted} ${head}\n`);
    expect((await git('diff', '--name-only', 'trusted...HEAD')).trim()).toBe('');
    expect(await makeGitReader({ cwd: repo }).diffNameOnly('trusted')).toEqual(['src/App.tsx']);
  });

  it('reads an edit to a present file that agent-written sparse patterns leave out', async () => {
    const before = await tree();
    await git('config', 'core.sparseCheckout', 'true');
    await write('.git/info/sparse-checkout', '/*\n!/src/App.tsx\n');
    await write('src/App.tsx', APP_EDITED);
    expect(await paths()).toEqual(['src/App.tsx']);
    expect(await tree()).not.toBe(before);
  });

  it('reads an uncommitted edit inside a submodule, by its path in the outer repository', async () => {
    const lib = join(home, 'lib-source');
    await newRepo(lib);
    await write('ui/Lib.tsx', 'export const Lib = "<label>x</label>";\n', lib);
    await commitAll('lib', lib);
    await git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    await commitAll('submodule');
    const before = await tree();
    expect(await paths()).toEqual([]);
    await write('lib/ui/Lib.tsx', 'export const Lib = "<b>no label</b>";\n');
    expect(await paths()).toEqual(['lib/ui/Lib.tsx']);
    expect(await tree()).not.toBe(before);
  });
});

describe('honest filters read an unchanged file as unchanged', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  // A filter in the shape of Git LFS: the commit holds a pointer, the working tree the content.
  async function lfsStyle(): Promise<void> {
    const store = join(home, 'lfs-store');
    await mkdir(store);
    const clean = await script(
      'lfs-clean.sh',
      [
        't=$(mktemp); cat > "$t"',
        'oid=$(sha256sum "$t" | cut -d" " -f1); size=$(wc -c < "$t" | tr -d " ")',
        `cp "$t" "${store}/$oid"`,
        "printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:%s\\nsize %s\\n' \"$oid\" \"$size\"",
        'rm -f "$t"',
      ].join('\n'),
    );
    const smudge = await script(
      'lfs-smudge.sh',
      [`oid=$(sed -n 's/^oid sha256:\\([0-9a-f]*\\)$/\\1/p')`, `cat "${store}/$oid"`].join('\n'),
    );
    await writeFile(
      join(home, 'gitconfig'),
      `[core]\n\thooksPath = /dev/null\n[filter "lfsstyle"]\n\tclean = ${clean}\n\tsmudge = ${smudge}\n\trequired = true\n`,
    );
    await write('.gitattributes', '*.bin filter=lfsstyle\n');
    await write('assets/big.bin', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)));
    await commitAll('lfs');
    await rm(join(repo, 'assets/big.bin'));
    await git('checkout', '--', 'assets/big.bin');
    expect(await git('cat-file', 'blob', 'HEAD:assets/big.bin')).toMatch(/^version https:\/\/git-lfs/u);
  }

  posixOnly('reads an LFS-style file with its content on disk as unchanged, with a stable tree', async () => {
    await lfsStyle();
    const first = await tree();
    expect(await paths()).toEqual([]);
    expect(await tree()).toBe(first);
  });

  posixOnly('reads an edit to an LFS-style file', async () => {
    await lfsStyle();
    const first = await tree();
    await writeFile(join(repo, 'assets/big.bin'), 'other content\n', { flag: 'a' });
    expect(await paths()).toEqual(['assets/big.bin']);
    expect(await tree()).not.toBe(first);
  });

  it('reads a committed eol=crlf file as unchanged, with a stable tree, and reads an edit to it', async () => {
    await write('.gitattributes', '*.tsx text eol=crlf\n');
    await commitAll('crlf');
    await rm(join(repo, 'src/App.tsx'));
    await git('checkout', '--', 'src/App.tsx');
    expect((await readFile(join(repo, 'src/App.tsx'), 'utf8')).endsWith('\r\n')).toBe(true);
    const first = await tree();
    expect(await paths()).toEqual([]);
    expect(await tree()).toBe(first);
    await write('src/App.tsx', APP_EDITED.replace('\n', '\r\n'));
    expect(await paths()).toEqual(['src/App.tsx']);
    expect(await tree()).not.toBe(first);
  });

  it('reads a committed ident file whose marker checkout expanded as unchanged', async () => {
    await write('.gitattributes', '*.tsx ident\n');
    await write('src/App.tsx', 'export const App = "$Id$";\n');
    await commitAll('ident');
    await rm(join(repo, 'src/App.tsx'));
    await git('checkout', '--', 'src/App.tsx');
    expect(await paths()).toEqual([]);
  });

  it('reads a cone sparse checkout as unchanged, with the folders it left out not listed', async () => {
    await write('docs/guide.md', 'guide\n');
    await commitAll('docs');
    await git('sparse-checkout', 'set', '--cone', 'src');
    const first = await tree();
    expect(await paths()).toEqual([]);
    expect(await tree()).toBe(first);
  });
});

describe('the hash a reader keeps between its own reads', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('reads a same-size edit with the same modification time made within two seconds of the last read', async () => {
    const reader = makeGitReader({ cwd: repo });
    await write('src/App.tsx', APP);
    const first = await reader.writeTree();
    const { mtime } = await stat(join(repo, 'src/App.tsx'));
    await write('src/App.tsx', APP_EDITED);
    await utimes(join(repo, 'src/App.tsx'), mtime, mtime);
    expect(await reader.writeTree()).not.toBe(first);
    expect((await reader.statusZ()).map((entry) => entry.path)).toEqual(['src/App.tsx']);
  });

  it('reads a same-size edit with its modification time restored on a file older than two seconds', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const reader = makeGitReader({ cwd: repo });
    const first = await reader.writeTree();
    expect(await reader.writeTree()).toBe(first);
    const { mtime } = await stat(join(repo, 'src/App.tsx'));
    await write('src/App.tsx', APP_EDITED);
    await utimes(join(repo, 'src/App.tsx'), mtime, mtime);
    expect(await reader.writeTree()).not.toBe(first);
    expect((await reader.statusZ()).map((entry) => entry.path)).toEqual(['src/App.tsx']);
  });
});

describe('the repository root', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  posixOnly('reads from a folder reached through a link inside the repository', async () => {
    await mkdir(join(repo, 'x/y'), { recursive: true });
    await write('x/y/keep.txt', 'keep\n');
    await commitAll('folders');
    await symlink(join(repo, 'x/y'), join(repo, 'deep'));
    await write('src/App.tsx', APP_EDITED);
    await git('update-index', '--assume-unchanged', 'src/App.tsx');
    expect((await paths(join(repo, 'deep'))).filter((path) => path !== 'deep')).toEqual(['src/App.tsx']);
  });

  it('refuses to read when core.worktree points git at another folder', async () => {
    const decoy = join(home, 'decoy');
    await mkdir(join(decoy, 'src'), { recursive: true });
    await writeFile(join(decoy, 'src/App.tsx'), APP);
    await writeFile(join(decoy, 'src/Other.tsx'), 'export const Other = 1;\n');
    await git('config', 'core.worktree', decoy);
    await write('src/App.tsx', APP_EDITED);
    const reader = makeGitReader({ cwd: repo });
    await expect(reader.writeTree()).rejects.toThrow(/core\.worktree|outside/u);
    await expect(reader.statusZ()).rejects.toThrow(/core\.worktree|outside/u);
  });
});

describe('a sparse pattern file git cannot answer from', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('lists a deleted skip-worktree file when the pattern file is empty', async () => {
    await git('config', 'core.sparseCheckout', 'true');
    await write('.git/info/sparse-checkout', '');
    await git('update-index', '--skip-worktree', 'src/App.tsx');
    await rm(join(repo, 'src/App.tsx'));
    expect(await paths()).toEqual(['src/App.tsx']);
  });

  it('lists a deleted skip-worktree file when a folder stands in place of the pattern file', async () => {
    await git('config', 'core.sparseCheckout', 'true');
    await mkdir(join(repo, '.git/info/sparse-checkout'), { recursive: true });
    await git('update-index', '--skip-worktree', 'src/App.tsx');
    await rm(join(repo, 'src/App.tsx'));
    expect(await paths()).toEqual(['src/App.tsx']);
  });
});
