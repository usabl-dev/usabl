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
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
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

async function stop(): Promise<{ stderr: string; scanned: string[] }> {
  const out: string[] = [];
  state.scanned = [];
  const ports = {
    ...makeStopHookRunnerPorts({ startDir: repo, env: {} }),
    pins: memoryPinStore(),
    stdoutWrite: async () => {},
    stderrWrite: async (text: string) => {
      out.push(text);
    },
  };
  await runStopHookFromStdin('{}', ports);
  return { stderr: out.join(''), scanned: [...state.scanned] };
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
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    savedEnv[key] = process.env[key];
  }
  await writeFile(join(home, 'gitconfig'), '[core]\n\thooksPath = /dev/null\n');
  process.env['GIT_CONFIG_GLOBAL'] = join(home, 'gitconfig');
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
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
  });
});
