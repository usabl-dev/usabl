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
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
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
  // usabl gives git no GIT_CONFIG_* variable, so the test's own global config is the one in its own
  // HOME, for usabl's git calls and the test's alike.
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_COMMITTER_DATE', 'GIT_AUTHOR_DATE']) {
    savedEnv[key] = process.env[key];
  }
  await writeFile(join(home, '.gitconfig'), '[core]\n\thooksPath = /dev/null\n');
  process.env['HOME'] = home;
  process.env['XDG_CONFIG_HOME'] = join(home, '.config');
  delete process.env['GIT_CONFIG_GLOBAL'];
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  // One fixed date for every commit. The graft tests make a cycle of parents, and the merge base
  // git finds in a cycle depends on commit dates, so a commit that lands in another second would
  // change what the precondition reads.
  process.env['GIT_COMMITTER_DATE'] = '2026-01-01T00:00:00Z';
  process.env['GIT_AUTHOR_DATE'] = '2026-01-01T00:00:00Z';
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
    // The file gets a whole second a minute in the past, and git status records it, so the index is
    // newer than the file. Restoring a time read back with stat() is not exact: its Date is rounded
    // to the millisecond, so a time in the last half millisecond of a second moves to the next
    // second, and git then sees the edit. A whole second restores exactly.
    const past = Math.floor(Date.now() / 1000) - 60;
    await utimes(join(repo, 'src/App.tsx'), past, past);
    await git('status', '--porcelain');
    await write('src/App.tsx', APP_EDITED);
    await utimes(join(repo, 'src/App.tsx'), past, past);
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
      join(home, '.gitconfig'),
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
    await write('src/App.tsx', APP_EDITED.replaceAll('\n', '\r\n'));
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
  // Each test sets a whole second and restores that same second after the edit, so the
  // modification time is the same to the nanosecond. A time read back with stat() is a Date rounded
  // to the millisecond, so restoring it could move the time, and the edit would be easier to see
  // than the case the test means.
  const sameTime = async (path: string, seconds: number): Promise<void> => {
    await utimes(path, seconds, seconds);
    expect((await stat(path, { bigint: true })).mtimeNs).toBe(BigInt(seconds) * 1_000_000_000n);
  };

  it('reads a same-size edit with the same modification time made within two seconds of the last read', async () => {
    const reader = makeGitReader({ cwd: repo });
    const path = join(repo, 'src/App.tsx');
    const now = Math.floor(Date.now() / 1000);
    await write('src/App.tsx', APP);
    await sameTime(path, now);
    const first = await reader.writeTree();
    await write('src/App.tsx', APP_EDITED);
    await sameTime(path, now);
    expect(await reader.writeTree()).not.toBe(first);
    expect((await reader.statusZ()).map((entry) => entry.path)).toEqual(['src/App.tsx']);
  });

  it('reads a same-size edit with its modification time restored on a file older than two seconds', async () => {
    const path = join(repo, 'src/App.tsx');
    const past = Math.floor(Date.now() / 1000) - 60;
    await sameTime(path, past);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const reader = makeGitReader({ cwd: repo });
    const first = await reader.writeTree();
    expect(await reader.writeTree()).toBe(first);
    await write('src/App.tsx', APP_EDITED);
    await sameTime(path, past);
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

// Overwrites the loose object file of an id with other bytes of the given type. git does not check
// an object's id against its bytes when it reads it.
async function forgeObject(id: string, type: 'blob' | 'tree' | 'commit', content: Buffer): Promise<void> {
  const path = join(repo, '.git/objects', id.slice(0, 2), id.slice(2));
  await chmod(path, 0o644);
  await writeFile(path, deflateSync(Buffer.concat([Buffer.from(`${type} ${String(content.length)}\0`), content])));
}

describe('paths git would leave out of the tree', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  for (const folder of ['GIT~1', '.GIT']) {
    it(`moves the tree, on every read, for a new file in a folder named ${folder}`, async () => {
      const before = await tree();
      await write(`src/pages/${folder}/Admin.tsx`, 'export const Admin = () => <input />;\n');
      const first = await tree();
      expect(first).not.toBe(before);
      expect(await tree()).not.toBe(first);
      expect(await paths()).toContain(`src/pages/${folder}/Admin.tsx`);
    });
  }

  posixOnly('never hashes a file through a link in its folder, and lists the committed file as gone', async () => {
    await write('src/pages/Home.tsx', 'export const Home = 1;\n');
    await write('lib/pages/Home.tsx', 'export const Home = 2;\n');
    await commitAll('pages');
    const before = await tree();
    // A link to a folder the walk hashes: the files below it are bound through their real paths.
    await rm(join(repo, 'src/pages'), { recursive: true });
    await symlink('../lib/pages', join(repo, 'src/pages'));
    const first = await tree();
    expect(first).not.toBe(before);
    expect(await tree()).toBe(first);
    expect(await paths()).toEqual(['src/pages', 'src/pages/Home.tsx']);
  });

  posixOnly('refuses to list, naming the link, when a screen folder is swapped for a link to a folder outside', async () => {
    await write('src/pages/Home.tsx', 'export const Home = 1;\n');
    await commitAll('pages');
    const before = await tree();
    const outside = join(home, 'pages');
    await mkdir(outside);
    await rename(join(repo, 'src/pages/Home.tsx'), join(outside, 'Home.tsx'));
    await rm(join(repo, 'src/pages'), { recursive: true });
    await symlink(outside, join(repo, 'src/pages'));
    await writeFile(join(outside, 'Admin.tsx'), 'export const Admin = () => <input />;\n');
    const first = await tree();
    expect(first).not.toBe(before);
    expect(await tree()).not.toBe(first);
    await expect(paths()).rejects.toThrow(/src\/pages is a link to .*outside the files usabl hashes.*replace the link/su);
  });
});

describe('objects the agent can overwrite in .git/objects', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('reads an edit whose HEAD blob is forged as an LFS pointer to the edited bytes', async () => {
    await write('src/App.tsx', APP_EDITED);
    const disk = await readFile(join(repo, 'src/App.tsx'));
    const id = (await git('rev-parse', 'HEAD:src/App.tsx')).trim();
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(disk).digest('hex')}\nsize ${String(disk.length)}\n`;
    await forgeObject(id, 'blob', Buffer.from(pointer));
    expect(await paths()).toEqual(['src/App.tsx']);
  });

  it('refuses to read when the HEAD tree is forged to hold the edited blob', async () => {
    await write('src/App.tsx', APP_EDITED);
    const edited = (await git('hash-object', '-w', 'src/App.tsx')).trim();
    const srcTree = (await git('rev-parse', 'HEAD:src')).trim();
    const listing = await git('ls-tree', srcTree);
    const forgedListing = listing.replace(/^(100644 blob )[0-9a-f]+(\tApp\.tsx)$/mu, `$1${edited}$2`);
    const made = await new Promise<string>((resolve, reject) => {
      const child = execFile('git', ['mktree'], { cwd: repo, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
      child.stdin?.end(forgedListing);
    });
    const { stdout: raw } = await execFileAsync('git', ['cat-file', 'tree', made], { cwd: repo, encoding: 'buffer' });
    await forgeObject(srcTree, 'tree', raw);
    // git ls-tree -r HEAD reads the forged tree without checking its id.
    expect((await git('ls-tree', '-r', 'HEAD')).includes(edited)).toBe(true);
    const reader = makeGitReader({ cwd: repo });
    await expect(reader.statusZ()).rejects.toThrow(/does not hold the bytes its id names/u);
    await expect(reader.writeTree()).rejects.toThrow(/git fsck/u);
  });
});

describe('a HEAD commit object overwritten with other bytes', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('reads as damaged objects that name git fsck, never as a repository with no commits', async () => {
    const id = (await git('rev-parse', 'HEAD')).trim();
    const text = Buffer.from(await git('cat-file', 'commit', id), 'utf8');
    await forgeObject(id, 'commit', Buffer.concat([text, Buffer.from('\n')]));
    const reader = makeGitReader({ cwd: repo });
    const error = await reader.listEntries('HEAD', ['src/App.tsx'], { recursive: false }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/git fsck/u);
    expect((error as Error).message).not.toMatch(/no commits yet/u);
    await expect(reader.statusZ()).rejects.toThrow(/git fsck/u);
  });
});

describe('settings and variables that point git elsewhere', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('refuses to read when core.worktree names a parent repository that ignores this one', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'usabl-raw-bytes-parent-')));
    try {
      await newRepo(parent);
      await write('.gitignore', 'project/\n', parent);
      await commitAll('parent', parent);
      const project = join(parent, 'project');
      await newRepo(project);
      await write('src/App.tsx', APP, project);
      await commitAll('base', project);
      await gitIn(project, 'config', 'core.worktree', parent);
      await write('src/App.tsx', APP_EDITED, project);
      const reader = makeGitReader({ cwd: project });
      await expect(reader.statusZ()).rejects.toThrow(/core\.worktree/u);
      await expect(reader.writeTree()).rejects.toThrow(/core\.worktree/u);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('ignores GIT_DIR and GIT_WORK_TREE in its own environment', async () => {
    const decoy = join(home, 'decoy');
    await newRepo(decoy);
    await write('src/App.tsx', APP, decoy);
    await commitAll('decoy', decoy);
    await write('src/App.tsx', APP_EDITED);
    const saved = { dir: process.env['GIT_DIR'], tree: process.env['GIT_WORK_TREE'] };
    process.env['GIT_DIR'] = join(decoy, '.git');
    process.env['GIT_WORK_TREE'] = decoy;
    try {
      expect(await paths()).toEqual(['src/App.tsx']);
    } finally {
      if (saved.dir === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = saved.dir;
      if (saved.tree === undefined) delete process.env['GIT_WORK_TREE'];
      else process.env['GIT_WORK_TREE'] = saved.tree;
    }
  });

  it('reads a new file whose name differs from a tracked one only in case when core.ignorecase is true', async () => {
    const before = await tree();
    await git('config', 'core.ignorecase', 'true');
    await write('src/app.tsx', 'export const app = () => <input />;\n');
    expect(await paths()).toEqual(['src/app.tsx']);
    expect(await tree()).not.toBe(before);
  });

  it('reads a new file in a .GIT folder when core.ignorecase is true', async () => {
    const before = await tree();
    await git('config', 'core.ignorecase', 'true');
    await write('src/.GIT/x.tsx', 'export const x = () => <input />;\n');
    expect(await paths()).toEqual(['src/.GIT/x.tsx']);
    expect(await tree()).not.toBe(before);
  });
});

describe('links whose target the walk does not hash', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  posixOnly('binds a link to a file outside the repository by its text and the file, and always lists it', async () => {
    await writeFile(join(home, 'Shared.tsx'), APP);
    await symlink(join(home, 'Shared.tsx'), join(repo, 'src/Shared.tsx'));
    await commitAll('link out');
    const first = await tree();
    expect(await tree()).toBe(first);
    // HEAD holds only the link text, so nothing says the target is the one checked before.
    expect(await paths()).toEqual(['src/Shared.tsx']);
    await writeFile(join(home, 'Shared.tsx'), APP_EDITED);
    const edited = await tree();
    expect(edited).not.toBe(first);
    expect(await tree()).toBe(edited);
    expect(await paths()).toEqual(['src/Shared.tsx']);
  });

  posixOnly('binds a committed link into an ignored dist folder by the file it serves', async () => {
    await write('.gitignore', 'dist/\n');
    await symlink('../dist/App.js', join(repo, 'src/Built.js'));
    await commitAll('built link');
    await write('dist/App.js', 'export const App = 1;\n');
    const first = await tree();
    expect(await tree()).toBe(first);
    expect(await paths()).toEqual(['src/Built.js']);
    await write('dist/App.js', 'export const App = 2;\n');
    expect(await tree()).not.toBe(first);
  });

  posixOnly('binds a link that points nowhere by its text alone', async () => {
    await symlink('../dist/Missing.js', join(repo, 'src/Missing.js'));
    await commitAll('dangling link');
    const first = await tree();
    expect(await tree()).toBe(first);
    expect(await paths()).toEqual([]);
  });

  posixOnly('refuses to list, naming the link and the fix, for a new link to a folder outside the repository', async () => {
    await mkdir(join(home, 'assets'));
    await writeFile(join(home, 'assets', 'logo.svg'), '<svg/>');
    await symlink(join(home, 'assets'), join(repo, 'src/assets'));
    const first = await tree();
    expect(await tree()).not.toBe(first);
    await expect(paths()).rejects.toThrow(/src\/assets is a link to .*outside the files usabl hashes.*Commit what it points to, or replace the link/su);
  });

  posixOnly('keeps the tree for a link to a tracked file in the repository', async () => {
    await symlink('App.tsx', join(repo, 'src/Alias.tsx'));
    await commitAll('alias');
    const first = await tree();
    expect(await tree()).toBe(first);
    expect(await paths()).toEqual([]);
  });
});

// A python3 that can map a file, for the memory map test. Without one the test is skipped.
const hasPython = ((): boolean => {
  try {
    execFileSync('python3', ['-c', 'import mmap'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const withMemoryMap = process.platform === 'win32' || !hasPython ? it.skip : it;

describe('the tree a receipt binds', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  withMemoryMap('is hashed fresh, so a second write through a memory map that keeps both file times still moves it', async () => {
    const path = join(repo, 'src/Mapped.tsx');
    await writeFile(path, 'A'.repeat(4096));
    // Maps the file and writes one byte at an offset for each line "<offset> <letter>" on stdin.
    // Once a page is dirty, a second write to it moves neither the modification time nor the
    // change time, until the kernel writes the page back.
    const mapper = spawn(
      'python3',
      [
        '-c',
        'import mmap,os,sys\nfd=os.open(sys.argv[1],os.O_RDWR)\nm=mmap.mmap(fd,4096)\nfor line in sys.stdin:\n  at,letter=line.split()\n  m[int(at):int(at)+1]=letter.encode()\n  print("ok",flush=True)',
        path,
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const lines: string[] = [];
    mapper.stdout.on('data', (chunk: Buffer) => lines.push(...chunk.toString('utf8').split('\n').filter((line) => line.length > 0)));
    const mapWrite = async (at: number, letter: string): Promise<void> => {
      mapper.stdin.write(`${String(at)} ${letter}\n`);
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (lines.shift() !== undefined) resolve();
          else setTimeout(check, 20);
        };
        check();
      });
    };
    try {
      let shown = false;
      // The kernel can write the page back between the two writes, which moves the times. Then
      // the case did not happen, so it is tried again on a new pair of bytes.
      for (let attempt = 0; attempt < 3 && !shown; attempt += 1) {
        await mapWrite(attempt * 2, 'B');
        // Past the two-second window, so the changed list keeps the hash in its cache.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const reader = makeGitReader({ cwd: repo });
        await reader.statusZ();
        const before = await reader.writeTree();
        const times = await stat(path, { bigint: true });
        await mapWrite(attempt * 2 + 1, 'C');
        const after = await stat(path, { bigint: true });
        if (after.mtimeNs !== times.mtimeNs || after.ctimeNs !== times.ctimeNs) continue;
        shown = true;
        expect((await readFile(path, 'latin1')).slice(attempt * 2, attempt * 2 + 2)).toBe('BC');
        const moved = await reader.writeTree();
        expect(moved).not.toBe(before);
        expect(moved).toBe(await tree());
      }
      expect(shown, 'a second write through the map kept both file times in one of three tries').toBe(true);
    } finally {
      mapper.stdin.end();
      mapper.kill();
    }
  });
});
