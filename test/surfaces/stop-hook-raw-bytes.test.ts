/**
 * After a verified stop, an edit that a local git setting hides is still an edit at the next
 * stop: the stop checks the screen it reaches, never answers from the stored receipt, and never
 * reads "nothing to check". Each route is one setting or file the agent can write from inside the
 * repository, with no tracked change: a clean filter, ident, working-tree-encoding,
 * core.trustctime, an fsmonitor hook, a replace ref, a graft, or an edit inside a submodule.
 *
 * Real git in a temporary folder, the real CLI and hook, and the fake browser the Stop hook tests
 * use: buildDeps is replaced so no browser starts, and the check runner records what it scanned.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { patchCommitGraphParent } from '../support/commit-graph.js';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

const state = vi.hoisted(() => ({ scanned: [] as string[] }));

vi.mock('../../src/deps/build.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/deps/build.js')>();
  return {
    ...original,
    buildDeps: async (_config: UsablConfig, options: { cwd?: string } = {}): Promise<Deps> => {
      const cwd = options.cwd ?? process.cwd();
      const fake = makeFakeDeps();
      return {
        ...fake,
        git: makeGitReader({ cwd }),
        fs: makeFsGlob({ cwd }),
        checkRunner: {
          scan: async (screen) => {
            state.scanned.push(screen.id);
            return fake.checkRunner.scan(screen);
          },
        },
      };
    },
  };
});

const { main } = await import('../../src/cli.js');
const { makeStopHookRunnerPorts, runStopHookFromStdin } = await import('../../src/surfaces/stop-hook-runner.js');
const { memoryPinStore } = await import('../support/memory-pin-store.js');

const posixOnly = process.platform === 'win32' ? it.skip : it;

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**', 'lib/**'],
  discovery: { routerFile: 'src/routes.tsx', wideBlastGlobs: [] },
  surfaces: [
    { id: 'home', url: 'http://127.0.0.1:5173/', files: ['src/App.tsx'] },
    { id: 'other', url: 'http://127.0.0.1:5173/other', files: ['src/Other.tsx'] },
    { id: 'lib', url: 'http://127.0.0.1:5173/lib', files: ['lib/ui/Lib.tsx'] },
  ],
  guardedPaths: [],
};

const FAST_PATH = 'stored receipt, not re-scanned';
const NOTHING_TO_CHECK = 'nothing to check';
const LABEL = '<label htmlFor="n">Name</label>';
const APP = `export const App = () => ${LABEL};\n`;
// The same size as APP, with the label gone.
const APP_EDITED = APP.replace(LABEL, `<b>${'x'.repeat(LABEL.length - 7)}</b>`);

let repo = '';
let home = '';
let originalCwd = '';
const savedEnv: Record<string, string | undefined> = {};

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=usabl test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function git(...args: string[]): string {
  return gitIn(repo, ...args);
}

async function write(path: string, text: string, base: string = repo): Promise<void> {
  await mkdir(join(base, path, '..'), { recursive: true });
  await writeFile(join(base, path), text);
}

async function script(name: string, body: string): Promise<string> {
  const path = join(home, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/**
 * A feature branch whose one commit changes src/Other.tsx, so a check has a screen to verify and
 * mints a receipt. `before` runs first, for a route that needs the committed state it sets up.
 */
async function setUp(before: () => Promise<void> = async () => {}): Promise<void> {
  git('init', '-q', '-b', 'main');
  await write('.gitignore', '.usabl/\n');
  await write('usabl.config.json', JSON.stringify(config, null, 2) + '\n');
  await write('src/App.tsx', APP);
  await write('src/Other.tsx', 'export const Other = 1;\n');
  await before();
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('switch', '-q', '-c', 'feature');
  await write('src/Other.tsx', 'export const Other = 2;\n');
  git('commit', '-q', '-am', 'change the other screen');
}

/** The verified stop the route starts from: it answers from the receipt the check minted. */
async function verifiedStop(): Promise<void> {
  state.scanned = [];
  expect(await main(['check', '--branch-scope'])).toBe(0);
  const first = await stop();
  expect(first.stderr).toContain(FAST_PATH);
}

// A stop with no session id compares no pins. A test of session drift passes one store to every stop.
async function stop(input = '{}', pins = memoryPinStore()): Promise<{ stdout: string; stderr: string; scanned: string[] }> {
  const out: string[] = [];
  const decision: string[] = [];
  state.scanned = [];
  const ports = {
    ...makeStopHookRunnerPorts({ startDir: repo, env: {} }),
    pins,
    stdoutWrite: async (text: string) => {
      decision.push(text);
    },
    stderrWrite: async (text: string) => {
      out.push(text);
    },
  };
  await runStopHookFromStdin(input, ports);
  return { stdout: decision.join(''), stderr: out.join(''), scanned: [...state.scanned] };
}

/** The next stop checks the screen the hidden edit reaches. */
async function expectChecked(screen: string): Promise<void> {
  const next = await stop();
  expect(next.stderr).not.toContain(FAST_PATH);
  expect(next.stderr).not.toContain(NOTHING_TO_CHECK);
  expect(next.scanned).toContain(screen);
}

beforeEach(async () => {
  originalCwd = process.cwd();
  home = await realpath(await mkdtemp(join(tmpdir(), 'usabl-raw-stop-home-')));
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
  repo = await realpath(await mkdtemp(join(tmpdir(), 'usabl-raw-stop-')));
  process.chdir(repo);
  const capture = (() => true) as typeof process.stdout.write;
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  expect(APP_EDITED.length).toBe(APP.length);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
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

describe('an edit a local git setting hides, after a verified stop', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  posixOnly('is checked under a clean filter from the local config', async () => {
    await setUp();
    await verifiedStop();
    const hide = await script('hide.sh', 'git cat-file blob "HEAD:$1"');
    git('config', 'filter.hide.clean', `${hide} %f`);
    await write('.git/info/attributes', 'src/App.tsx filter=hide\n');
    await write('src/App.tsx', APP_EDITED);
    await expectChecked('home');
  });

  it('is checked under ident in .git/info/attributes', async () => {
    await setUp(async () => {
      await write('src/App.tsx', 'export const App = "$Id$<label>Name</label>";\n');
    });
    await write('.git/info/attributes', '*.tsx ident\n');
    await rm(join(repo, 'src/App.tsx'));
    git('checkout', '--', 'src/App.tsx');
    await verifiedStop();
    const expanded = await readFile(join(repo, 'src/App.tsx'), 'utf8');
    const marker = /\$Id: [0-9a-f]{40} \$/u.exec(expanded)?.[0] ?? '';
    const payload = '$Id: "/><b>injected</b><i a="x ';
    await write('src/App.tsx', expanded.replace(marker, `${payload}${'_'.repeat(marker.length - payload.length - 1)}$`));
    await expectChecked('home');
  });

  it('is checked under working-tree-encoding in .git/info/attributes', async () => {
    await setUp(async () => {
      await write('src/App.tsx', "export const App = '<label for=\"n\">Name</label>';\n");
    });
    await verifiedStop();
    await write('.git/info/attributes', 'src/App.tsx working-tree-encoding=UTF-7\n');
    await write('src/App.tsx', "export const App = '+ADw-label for=\"n\"+AD4-Name+ADw-/label+AD4-';\n");
    await expectChecked('home');
  });

  it('is checked when core.trustctime is false and the modification time is restored', async () => {
    await setUp();
    git('config', 'core.trustctime', 'false');
    await verifiedStop();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    git('status', '--porcelain');
    const { mtime } = await stat(join(repo, 'src/App.tsx'));
    await write('src/App.tsx', APP_EDITED);
    await utimes(join(repo, 'src/App.tsx'), mtime, mtime);
    expect(git('status', '--porcelain')).toBe('');
    await expectChecked('home');
  });

  posixOnly('is checked when an fsmonitor hook says nothing changed', async () => {
    await setUp();
    await verifiedStop();
    const hook = await script('fsmonitor.sh', 'printf "token\\0"');
    git('config', 'core.fsmonitor', hook);
    git('status', '--porcelain');
    await write('src/App.tsx', 'export const App = () => <b>longer and without a label</b>;\n');
    expect(git('status', '--porcelain')).toBe('');
    await expectChecked('home');
  });

  it('is checked when replace refs swap the HEAD tree and the trusted tree for ones that hold the staged edit', async () => {
    await setUp();
    await verifiedStop();
    await write('src/App.tsx', APP_EDITED);
    const editedBlob = git('hash-object', '-w', 'src/App.tsx').trim();
    git('add', 'src/App.tsx');
    // The same edit in both trees, so git status and the diff from the starting commit read nothing.
    for (const commit of ['HEAD', 'origin/main']) {
      const original = git('rev-parse', `${commit}^{tree}`).trim();
      const index = join(home, `index-${commit.replace('/', '-')}`);
      execFileSync('git', ['read-tree', original], { cwd: repo, env: { ...process.env, GIT_INDEX_FILE: index } });
      execFileSync('git', ['update-index', '--cacheinfo', `100644,${editedBlob},src/App.tsx`], {
        cwd: repo,
        env: { ...process.env, GIT_INDEX_FILE: index },
      });
      const swapped = execFileSync('git', ['write-tree'], { cwd: repo, env: { ...process.env, GIT_INDEX_FILE: index }, encoding: 'utf8' }).trim();
      git('replace', original, swapped);
    }
    expect(git('status', '--porcelain')).toBe('');
    expect(git('diff', '--name-only', 'origin/main...HEAD').trim()).toBe('src/Other.tsx');
    await expectChecked('home');
  });

  it('is checked when a graft makes HEAD a parent of the trusted commit', async () => {
    await setUp();
    await verifiedStop();
    await write('src/App.tsx', APP_EDITED);
    git('commit', '-q', '-am', 'edit the screen');
    await write('.git/info/grafts', `${git('rev-parse', 'origin/main').trim()} ${git('rev-parse', 'HEAD').trim()}\n`);
    expect(git('diff', '--name-only', 'origin/main...HEAD').trim()).toBe('');
    await expectChecked('home');
  });

  it('is checked when the edit is inside a submodule', async () => {
    const lib = join(home, 'lib-source');
    await mkdir(lib);
    gitIn(lib, 'init', '-q', '-b', 'main');
    await write('ui/Lib.tsx', 'export const Lib = "<label>x</label>";\n', lib);
    gitIn(lib, 'add', '-A');
    gitIn(lib, 'commit', '-q', '-m', 'lib');
    await setUp(async () => {
      gitIn(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    });
    await verifiedStop();
    await write('lib/ui/Lib.tsx', 'export const Lib = "<b>no label</b>";\n');
    await expectChecked('lib');
  });

  it('is never verified when core.worktree points git at a copy of the committed files', async () => {
    await setUp();
    await verifiedStop();
    const decoy = join(home, 'decoy');
    for (const path of ['usabl.config.json', '.gitignore', 'src/App.tsx', 'src/Other.tsx']) {
      await write(path, await readFile(join(repo, path), 'utf8'), decoy);
    }
    // The decoy names the real repository, so git run there reads it as its work tree too.
    await writeFile(join(decoy, '.git'), `gitdir: ${join(repo, '.git')}\n`);
    git('config', 'core.worktree', decoy);
    await write('src/App.tsx', APP_EDITED);
    const next = await stop();
    expect(next.stderr).not.toContain(FAST_PATH);
    expect(next.stderr).not.toContain(NOTHING_TO_CHECK);
    expect(next.stderr).not.toMatch(/^VERIFIED/mu);
    // The stop blocks once, and says the working tree could not be read.
    const block = JSON.parse(next.stdout) as { decision?: string; reason?: string };
    expect(block.decision).toBe('block');
    expect(block.reason).toMatch(/core\.worktree/u);
  });
});

/** The block a stop prints on stdout, or an empty object when it printed none. */
function blockOf(stdout: string): { decision?: string; reason?: string } {
  return stdout.trim() === '' ? {} : (JSON.parse(stdout) as { decision?: string; reason?: string });
}

describe('a change git would leave out of the tree, after a verified stop', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('is never answered from the stored receipt for a new file under a GIT~1 folder', async () => {
    await setUp();
    await verifiedStop();
    await write('src/pages/GIT~1/Admin.tsx', 'export const Admin = () => <input />;\n');
    const next = await stop();
    expect(next.stderr).not.toContain(FAST_PATH);
    expect(next.stderr).not.toContain(NOTHING_TO_CHECK);
  });

  posixOnly('is never answered from the stored receipt when a screen folder is swapped for a link', async () => {
    await setUp(async () => {
      await write('src/pages/Home.tsx', 'export const Home = 1;\n');
    });
    await verifiedStop();
    const outside = join(home, 'pages');
    await mkdir(outside);
    await rename(join(repo, 'src/pages/Home.tsx'), join(outside, 'Home.tsx'));
    await rm(join(repo, 'src/pages'), { recursive: true });
    await symlink(outside, join(repo, 'src/pages'));
    await writeFile(join(outside, 'Admin.tsx'), 'export const Admin = () => <input />;\n');
    const next = await stop();
    expect(next.stderr).not.toContain(FAST_PATH);
    expect(next.stderr).not.toContain(NOTHING_TO_CHECK);
  });

  it('checks the edited screen when its HEAD blob is forged as an LFS pointer to the edited bytes', async () => {
    await setUp();
    await verifiedStop();
    await write('src/App.tsx', APP_EDITED);
    const disk = await readFile(join(repo, 'src/App.tsx'));
    const id = git('rev-parse', 'HEAD:src/App.tsx').trim();
    const pointer = Buffer.from(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(disk).digest('hex')}\nsize ${String(disk.length)}\n`,
    );
    const object = join(repo, '.git/objects', id.slice(0, 2), id.slice(2));
    await chmod(object, 0o644);
    await writeFile(object, deflateSync(Buffer.concat([Buffer.from(`blob ${String(pointer.length)}\0`), pointer])));
    await expectChecked('home');
  });
});

describe('a forged tree in .git/objects, after a verified stop', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('blocks the stop and names the damaged object', async () => {
    await setUp();
    await verifiedStop();
    await write('src/App.tsx', APP_EDITED);
    const edited = git('hash-object', '-w', 'src/App.tsx').trim();
    const srcTree = git('rev-parse', 'HEAD:src').trim();
    const forged = git('ls-tree', srcTree).replace(/^(100644 blob )[0-9a-f]+(\tApp\.tsx)$/mu, `$1${edited}$2`);
    const made = execFileSync('git', ['mktree'], { cwd: repo, input: forged, encoding: 'utf8' }).trim();
    const raw = execFileSync('git', ['cat-file', 'tree', made], { cwd: repo });
    const object = join(repo, '.git/objects', srcTree.slice(0, 2), srcTree.slice(2));
    await chmod(object, 0o644);
    await writeFile(object, deflateSync(Buffer.concat([Buffer.from(`tree ${String(raw.length)}\0`), raw])));
    const next = await stop();
    expect(next.stderr).not.toContain(FAST_PATH);
    expect(next.stderr).not.toMatch(/^VERIFIED/mu);
    const block = blockOf(next.stdout);
    expect(block.decision).toBe('block');
    expect(block.reason).toMatch(/git fsck/u);
  });
});

describe('core.worktree naming a parent repository that ignores this one', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('blocks the stop and fails usabl check, both naming the setting', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'usabl-raw-stop-parent-')));
    const project = repo;
    try {
      gitIn(parent, 'init', '-q', '-b', 'main');
      await write('.gitignore', 'r/\n', parent);
      await write('NOTES.md', 'notes\n', parent);
      gitIn(parent, 'add', '-A');
      gitIn(parent, 'commit', '-q', '-m', 'parent');
      repo = join(parent, 'r');
      await mkdir(repo);
      process.chdir(repo);
      await setUp();
      await verifiedStop();
      git('config', 'core.worktree', parent);
      await write('src/App.tsx', APP_EDITED);

      const next = await stop();
      expect(next.stderr).not.toContain(FAST_PATH);
      expect(next.stderr).not.toMatch(/^VERIFIED/mu);
      const block = blockOf(next.stdout);
      expect(block.decision).toBe('block');
      expect(block.reason).toMatch(/core\.worktree/u);

      const printed: string[] = [];
      const capture = ((text: string | Uint8Array) => {
        printed.push(String(text));
        return true;
      }) as typeof process.stdout.write;
      const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
      let code: number;
      try {
        code = await main(['check']);
      } finally {
        outSpy.mockRestore();
        errSpy.mockRestore();
      }
      expect(code).not.toBe(0);
      expect(printed.join('')).not.toMatch(/nothing to check/iu);
      expect(printed.join('')).toMatch(/core\.worktree/u);
    } finally {
      process.chdir(originalCwd);
      await rm(parent, { recursive: true, force: true });
      repo = project;
    }
  });
});

// The text of the gap for files that changed during a check. Waiting never clears a link.
const WAIT = 'Wait until no editor, build, or agent is writing files';

/** A plain usabl check, with what it printed. */
async function checkOutput(...args: string[]): Promise<{ code: number; printed: string }> {
  const printed: string[] = [];
  const capture = ((text: string | Uint8Array) => {
    printed.push(String(text));
    return true;
  }) as typeof process.stdout.write;
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  try {
    return { code: await main(['check', ...args]), printed: printed.join('') };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe('a screen file that is a link out of the hashed files', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  posixOnly('verifies a committed link into an ignored dist folder, and checks the screen after the target changes', async () => {
    await setUp(async () => {
      await write('.gitignore', '.usabl/\ndist/\n');
      await write('dist/App.tsx', APP);
      await rm(join(repo, 'src/App.tsx'));
      await symlink('../dist/App.tsx', join(repo, 'src/App.tsx'));
    });
    await verifiedStop();
    const again = await stop();
    expect(again.stderr).toContain(FAST_PATH);
    await write('dist/App.tsx', APP_EDITED);
    await expectChecked('home');
  });

  posixOnly('verifies a committed link that points nowhere, stop after stop', async () => {
    await setUp(async () => {
      await rm(join(repo, 'src/App.tsx'));
      await symlink('../dist/App.tsx', join(repo, 'src/App.tsx'));
    });
    await verifiedStop();
    expect((await stop()).stderr).toContain(FAST_PATH);
  });

  posixOnly('checks the screen when a link to a file outside the repository is edited there', async () => {
    await setUp();
    await verifiedStop();
    const copy = join(home, 'App.tsx');
    await writeFile(copy, APP);
    await rm(join(repo, 'src/App.tsx'));
    await symlink(copy, join(repo, 'src/App.tsx'));
    await expectChecked('home');
    await verifiedStop();
    await writeFile(copy, APP_EDITED);
    await expectChecked('home');
  });

  posixOnly('blocks every stop with a gap that names a link to a folder outside, and never says to wait', async () => {
    await setUp(async () => {
      await write('src/pages/Home.tsx', 'export const Home = 1;\n');
    });
    await verifiedStop();
    const outside = join(home, 'pages');
    await mkdir(outside);
    await rename(join(repo, 'src/pages/Home.tsx'), join(outside, 'Home.tsx'));
    await rm(join(repo, 'src/pages'), { recursive: true });
    await symlink(outside, join(repo, 'src/pages'));
    for (const input of ['{"session_id":"s1"}', '{"session_id":"s1","stop_hook_active":true}']) {
      const next = await stop(input);
      expect(next.scanned).toEqual([]);
      expect(next.stderr).not.toMatch(/^VERIFIED/mu);
      expect(next.stderr + next.stdout).not.toContain(WAIT);
      const text = input.includes('stop_hook_active') ? next.stderr : blockOf(next.stdout).reason ?? '';
      if (!input.includes('stop_hook_active')) expect(blockOf(next.stdout).decision).toBe('block');
      expect(text).toMatch(/^NOT verified - not covered: a link in this repository/mu);
      expect(text).toMatch(/link: src\/pages/u);
      expect(text).toMatch(/replace the link with/u);
    }
    const checked = await checkOutput();
    expect(checked.code).not.toBe(0);
    expect(checked.printed).toMatch(/src\/pages is a link/u);
    expect(checked.printed).not.toContain(WAIT);
  });
});

describe('a link to a folder outside, with no trusted branch', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  posixOnly('blocks the stop with the gap that names the link, never a failed run that does not block', async () => {
    await setUp();
    git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    git('update-ref', '-d', 'refs/remotes/origin/main');
    await mkdir(join(home, 'assets'));
    await writeFile(join(home, 'assets', 'logo.svg'), '<svg/>');
    await symlink(join(home, 'assets'), join(repo, 'src/assets'));
    const next = await stop();
    expect(next.stderr).not.toContain('is not blocking this stop');
    const block = blockOf(next.stdout);
    expect(block.decision).toBe('block');
    expect(block.reason).toMatch(/^NOT verified - not covered: a link in this repository/mu);
    expect(block.reason).toMatch(/link: src\/assets/u);
  });
});

describe('a HEAD commit object overwritten with other bytes, after a verified stop', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('blocks the stop with a reason that names git fsck', async () => {
    await setUp();
    await verifiedStop();
    await write('src/App.tsx', APP_EDITED);
    const id = git('rev-parse', 'HEAD').trim();
    const object = join(repo, '.git/objects', id.slice(0, 2), id.slice(2));
    const text = execFileSync('git', ['cat-file', 'commit', id], { cwd: repo });
    await chmod(object, 0o644);
    await writeFile(object, deflateSync(Buffer.concat([Buffer.from(`commit ${String(text.length + 1)}\0`), text, Buffer.from('\n')])));
    const next = await stop();
    expect(next.stderr).not.toMatch(/^VERIFIED/mu);
    expect(next.stderr).not.toContain('is not blocking this stop');
    const block = blockOf(next.stdout);
    expect(block.decision).toBe('block');
    expect(block.reason).toMatch(/git fsck/u);
  });
});

/** A tree object written to the store from a listing in git ls-tree's form: its id and bytes. */
function makeTree(listing: string): { id: string; raw: Buffer } {
  const id = execFileSync('git', ['mktree'], { cwd: repo, input: listing, encoding: 'utf8' }).trim();
  return { id, raw: execFileSync('git', ['cat-file', 'tree', id], { cwd: repo }) };
}

async function forgeObject(id: string, type: 'tree' | 'commit', content: Buffer): Promise<void> {
  const object = join(repo, '.git/objects', id.slice(0, 2), id.slice(2));
  await chmod(object, 0o644);
  await writeFile(object, deflateSync(Buffer.concat([Buffer.from(`${type} ${String(content.length)}\0`), content])));
}

// The src tree of a commit that holds the edited screen and the other screen as `commit` has it.
function srcWithEdit(commit: string): { id: string; raw: Buffer } {
  const edited = git('rev-parse', 'HEAD:src/App.tsx').trim();
  const other = git('rev-parse', `${commit}:src/Other.tsx`).trim();
  return makeTree(`100644 blob ${edited}\tApp.tsx\n100644 blob ${other}\tOther.tsx\n`);
}

describe('a committed edit hidden by a forged object on the trusted side', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('blocks the stop, naming git fsck, when a tree only the trusted side holds is forged to list the edit', async () => {
    await setUp();
    await verifiedStop();
    await write('src/App.tsx', APP_EDITED);
    git('commit', '-q', '-am', 'edit the screen');
    const trustedSrc = git('rev-parse', 'origin/main:src').trim();
    await forgeObject(trustedSrc, 'tree', srcWithEdit('origin/main').raw);
    // git diff reads the forged tree as stored, so it lists the other screen only.
    expect(git('diff', '--name-only', 'origin/main...HEAD').trim()).toBe('src/Other.tsx');
    const next = await stop();
    expect(next.stderr).not.toMatch(/^VERIFIED/mu);
    expect(next.stderr).not.toContain(NOTHING_TO_CHECK);
    expect(next.scanned).toEqual([]);
    const block = blockOf(next.stdout);
    expect(block.decision).toBe('block');
    expect(block.reason).toMatch(/git fsck/u);
  });

  it('fails usabl check --trusted-ref, naming git fsck, when the merge base commit is forged to name a tree that holds the edit', async () => {
    await setUp();
    // The trusted branch moves on, so the merge base is a commit git reaches only through parents.
    git('switch', '-q', 'main');
    await write('README.md', 'notes\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'the trusted branch moves on');
    git('update-ref', 'refs/remotes/origin/main', 'main');
    git('switch', '-q', 'feature');
    await write('src/App.tsx', APP_EDITED);
    git('commit', '-q', '-am', 'edit the screen');
    const base = git('merge-base', 'origin/main', 'HEAD').trim();
    const root = makeTree(
      `100644 blob ${git('rev-parse', `${base}:.gitignore`).trim()}\t.gitignore\n` +
        `040000 tree ${srcWithEdit(base).id}\tsrc\n` +
        `100644 blob ${git('rev-parse', `${base}:usabl.config.json`).trim()}\tusabl.config.json\n`,
    );
    const text = git('cat-file', 'commit', base);
    await forgeObject(base, 'commit', Buffer.from(text.replace(/^tree [0-9a-f]+\n/u, `tree ${root.id}\n`)));
    expect(git('diff', '--name-only', 'origin/main...HEAD').trim()).toBe('src/Other.tsx');
    state.scanned = [];
    // A listing that fails stops the check with an error, never a run on a list it could not read.
    const result = await checkOutput('--trusted-ref', 'origin/main').then(
      (done) => done.printed,
      (err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    expect(result).not.toMatch(/VERIFIED \(exit 0\)/u);
    expect(result).toMatch(/^failed: .*git fsck/u);
    expect(state.scanned).toEqual([]);
  });

  it('blocks the stop when the starting commit itself is forged', async () => {
    await setUp();
    await verifiedStop();
    await write('src/App.tsx', APP_EDITED);
    git('commit', '-q', '-am', 'edit the screen');
    const start = git('rev-parse', 'origin/main').trim();
    const text = git('cat-file', 'commit', start);
    await forgeObject(start, 'commit', Buffer.from(text.replace(/^tree [0-9a-f]+\n/u, `tree ${git('rev-parse', 'HEAD^{tree}').trim()}\n`)));
    const next = await stop();
    expect(next.stderr).not.toMatch(/^VERIFIED/mu);
    expect(next.stderr).not.toContain(NOTHING_TO_CHECK);
    expect(next.scanned).toEqual([]);
    expect(blockOf(next.stdout).decision).toBe('block');
  });
});

const SESSION = '{"session_id":"s1"}';
type PinStore = ReturnType<typeof memoryPinStore>;

/** The first stop of a session answers from the receipt the check minted, and records the pins. */
async function firstSessionStop(pins: PinStore): Promise<void> {
  state.scanned = [];
  expect(await main(['check', '--branch-scope'])).toBe(0);
  const first = await stop(SESSION, pins);
  expect(first.stderr).toContain(FAST_PATH);
  expect(pins.files.size).toBe(1);
}

/** A later stop of the session blocks as session drift, names the state, and checks nothing. */
async function expectDrift(pins: PinStore, name: string): Promise<void> {
  const next = await stop(SESSION, pins);
  expect(next.stderr).not.toMatch(/^VERIFIED/mu);
  expect(next.stderr).not.toContain(NOTHING_TO_CHECK);
  expect(next.scanned).toEqual([]);
  const block = blockOf(next.stdout);
  expect(block.decision).toBe('block');
  expect(block.reason).toMatch(/guarded policy drift during this session/u);
  expect(block.reason).toContain(name);
}

async function changedPaths(): Promise<string[]> {
  return (await makeGitReader({ cwd: repo }).statusZ()).map((entry) => entry.path);
}

// A folder the sparse patterns leave out of an honest checkout, set up before the session starts.
async function withDocs(): Promise<void> {
  await write('docs/Guide.md', 'guide\n');
}

describe('the sparse checkout state, pinned at the first stop of a session', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('blocks as drift when the agent leaves a screen file out with its own patterns and deletes it', async () => {
    const pins = memoryPinStore();
    await setUp();
    await firstSessionStop(pins);
    git('config', 'core.sparseCheckout', 'true');
    await write('.git/info/sparse-checkout', '/*\n!/src/App.tsx\n');
    git('update-index', '--skip-worktree', 'src/App.tsx');
    await rm(join(repo, 'src/App.tsx'));
    // The walk reads the file as left out on purpose, so the changed list does not hold it.
    expect(await changedPaths()).toEqual([]);
    await expectDrift(pins, '.git/info/sparse-checkout');
  });

  it('blocks as drift when sparse checkout is turned on during the session', async () => {
    const pins = memoryPinStore();
    await setUp();
    await firstSessionStop(pins);
    git('config', 'core.sparseCheckout', 'true');
    await write('.git/info/sparse-checkout', '/*\n');
    await expectDrift(pins, '.git/info/sparse-checkout');
  });

  it('blocks as drift when the pattern file is emptied', async () => {
    const pins = memoryPinStore();
    await setUp(withDocs);
    git('sparse-checkout', 'set', '--no-cone', '/*', '!/docs/');
    await firstSessionStop(pins);
    await writeFile(join(repo, '.git/info/sparse-checkout'), '');
    await expectDrift(pins, '.git/info/sparse-checkout');
  });

  it('blocks as drift when a folder stands in place of the pattern file', async () => {
    const pins = memoryPinStore();
    await setUp(withDocs);
    git('sparse-checkout', 'set', '--no-cone', '/*', '!/docs/');
    await firstSessionStop(pins);
    await rm(join(repo, '.git/info/sparse-checkout'));
    await mkdir(join(repo, '.git/info/sparse-checkout'));
    await expectDrift(pins, '.git/info/sparse-checkout');
  });

  it('never blocks an honest cone sparse checkout whose patterns do not change', async () => {
    const pins = memoryPinStore();
    await setUp(withDocs);
    git('sparse-checkout', 'set', '--cone', 'src');
    await firstSessionStop(pins);
    const again = await stop(SESSION, pins);
    expect(again.stdout).toBe('');
    expect(again.stderr).toContain(FAST_PATH);
    await write('src/App.tsx', APP_EDITED);
    const edited = await stop(SESSION, pins);
    expect(blockOf(edited.stdout).reason ?? '').not.toMatch(/drift/u);
    expect(edited.stderr).not.toContain(FAST_PATH);
    expect(edited.scanned).toContain('home');
  });
});

describe('a submodule folder emptied during a session', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('blocks as drift when the agent empties an initialized submodule folder, its .git included', async () => {
    const pins = memoryPinStore();
    const lib = join(home, 'lib-source');
    await mkdir(lib);
    gitIn(lib, 'init', '-q', '-b', 'main');
    await write('ui/Lib.tsx', 'export const Lib = "<label>x</label>";\n', lib);
    gitIn(lib, 'add', '-A');
    gitIn(lib, 'commit', '-q', '-m', 'lib');
    await setUp(async () => {
      gitIn(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    });
    await firstSessionStop(pins);
    await rm(join(repo, 'lib/ui'), { recursive: true });
    await rm(join(repo, 'lib/.git'), { recursive: true, force: true });
    // An empty submodule folder reads as never set up, so the changed list does not hold its files.
    expect(await changedPaths()).toEqual([]);
    await expectDrift(pins, '.git/modules');
  });

  it('blocks as drift when a submodule inside a submodule is dropped from it and its folder emptied', async () => {
    const pins = memoryPinStore();
    const deep = join(home, 'deep-source');
    await mkdir(deep);
    gitIn(deep, 'init', '-q', '-b', 'main');
    await write('ui/Lib.tsx', 'export const Lib = "<label>x</label>";\n', deep);
    gitIn(deep, 'add', '-A');
    gitIn(deep, 'commit', '-q', '-m', 'deep');
    const mid = join(home, 'mid-source');
    await mkdir(mid);
    gitIn(mid, 'init', '-q', '-b', 'main');
    await write('README.md', 'mid\n', mid);
    gitIn(mid, 'add', '-A');
    gitIn(mid, 'commit', '-q', '-m', 'mid');
    gitIn(mid, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', deep, 'ui');
    gitIn(mid, 'commit', '-q', '-m', 'add deep');
    await setUp(async () => {
      gitIn(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', mid, 'lib');
      gitIn(repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', '--recursive');
    });
    await firstSessionStop(pins);
    // In the middle submodule: a commit without the nested gitlink, and the nested folder emptied.
    const inner = join(repo, 'lib');
    gitIn(inner, 'rm', '-q', '--cached', 'ui');
    gitIn(inner, 'commit', '-q', '-m', 'drop ui');
    await rm(join(inner, 'ui'), { recursive: true, force: true });
    await mkdir(join(inner, 'ui'));
    expect(await changedPaths()).toEqual([]);
    await expectDrift(pins, '.git/modules');
  });
});

describe('a case setting that changes what the sparse patterns answer', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('checks a screen file inside honest patterns that is deleted under core.ignorecase=true', async () => {
    const pins = memoryPinStore();
    await setUp(async () => {
      await write('docs/a.md', 'a\n');
      // Docs/Page.tsx is a screen file inside the honest patterns, so it is on disk.
      await write('Docs/Page.tsx', 'export const Page = 1;\n');
      const withDocs: UsablConfig = {
        ...config,
        uiFileGlobs: [...config.uiFileGlobs, 'Docs/**'],
        surfaces: [...config.surfaces, { id: 'docs', url: 'http://127.0.0.1:5173/docs', files: ['Docs/Page.tsx'] }],
      };
      await write('usabl.config.json', JSON.stringify(withDocs, null, 2) + '\n');
    });
    git('sparse-checkout', 'set', '--no-cone', '/*', '!/docs/');
    await firstSessionStop(pins);
    git('config', 'core.ignorecase', 'true');
    git('update-index', '--skip-worktree', 'Docs/Page.tsx');
    await rm(join(repo, 'Docs/Page.tsx'));
    const next = await stop(SESSION, pins);
    expect(next.stderr).not.toContain(FAST_PATH);
    expect(next.stderr).not.toContain(NOTHING_TO_CHECK);
    expect(next.scanned).toContain('docs');
  });
});

describe('a commit-graph file that moves the merge base', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('checks a committed screen edit when the commit-graph makes HEAD a parent of a trusted commit', async () => {
    await setUp();
    git('switch', '-q', 'main');
    await write('NOTES.md', 'n1\n');
    git('add', 'NOTES.md');
    git('commit', '-q', '-m', 'n1');
    await write('NOTES.md', 'n2\n');
    git('commit', '-q', '-am', 'n2');
    git('update-ref', 'refs/remotes/origin/main', 'main');
    git('switch', '-q', 'feature');
    await write('src/App.tsx', APP_EDITED);
    git('commit', '-q', '-am', 'edit the screen');
    git('commit-graph', 'write', '--reachable', '--no-progress');
    const graph = join(repo, '.git/objects/info/commit-graph');
    await chmod(graph, 0o644);
    const head = git('rev-parse', 'HEAD').trim();
    patchCommitGraphParent(graph, git('rev-parse', 'origin/main~1').trim(), head);
    expect(git('merge-base', 'origin/main', 'HEAD').trim()).toBe(head);
    const next = await stop();
    expect(next.stderr).not.toContain(NOTHING_TO_CHECK);
    expect(next.scanned).toContain('home');
  });
});

describe('honest checkout changes that block as drift', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('names the checkout state and says how to go on after a merge that adds a submodule', async () => {
    const pins = memoryPinStore();
    const lib = join(home, 'lib-source');
    await mkdir(lib);
    gitIn(lib, 'init', '-q', '-b', 'main');
    await write('ui/Lib.tsx', 'export const Lib = 1;\n', lib);
    gitIn(lib, 'add', '-A');
    gitIn(lib, 'commit', '-q', '-m', 'lib');
    await setUp();
    await firstSessionStop(pins);
    git('switch', '-q', 'main');
    // A teammate's commit that adds a submodule: the gitlink and .gitmodules, nothing cloned here.
    await write('.gitmodules', `[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ${lib}\n`);
    git('add', '.gitmodules');
    git('update-index', '--add', '--cacheinfo', `160000,${gitIn(lib, 'rev-parse', 'HEAD').trim()},vendor/lib`);
    git('commit', '-q', '-m', 'add a submodule');
    git('update-ref', 'refs/remotes/origin/main', 'main');
    git('switch', '-q', 'feature');
    git('merge', '-q', '--no-edit', 'main');
    await expectDrift(pins, '.git/modules');
    const reason = blockOf((await stop(SESSION, pins)).stdout).reason ?? '';
    expect(reason).toMatch(/sparse checkout or submodule state changed/u);
    expect(reason).toMatch(/git submodule update --init/u);
    expect(reason).toMatch(/pin fix: /u);
    expect(reason).not.toMatch(/Do not edit those files/u);
  });
});
