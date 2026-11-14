/**
 * What a Stop hook checks. CI checks every file changed since the pull request left its base
 * branch, so the hook checks the same set: every file changed since this branch left the trusted
 * branch, plus changes that are not committed yet. An agent that commits its work and then stops
 * is checked, where the hook used to say there was nothing to check.
 *
 * These tests use real git, the real hook ports, and the real run(), with a fake check runner
 * that records which screens it was asked to scan.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import {
  makeStopHookRunnerPorts,
  runStopHookFromStdin,
  type StopHookRunnerPorts,
} from '../../src/surfaces/stop-hook-runner.js';
import { memoryPinStore } from '../support/memory-pin-store.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/routes.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'home', url: 'http://127.0.0.1:5173/', files: ['src/App.tsx'] }],
  guardedPaths: [],
};

const CONFIG_TEXT = JSON.stringify(config, null, 2) + '\n';

let repo = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=usabl test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(repo, path, '..'), { recursive: true });
  await writeFile(join(repo, path), text);
}

// The trusted branch as a clone records it: origin/main, named by refs/remotes/origin/HEAD.
function recordTrustedBranch(): void {
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'usabl-hook-scope-')));
  git('init', '-q', '-b', 'main');
  await write('.gitignore', '.usabl/\n');
  await write('usabl.config.json', CONFIG_TEXT);
  await write('src/App.tsx', 'export const App = 1;\n');
  await write('README.md', 'app\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function hook() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const scanned: string[] = [];
  const base = makeStopHookRunnerPorts({ startDir: repo, env: {} });
  const ports: StopHookRunnerPorts = {
    ...base,
    pins: memoryPinStore(),
    stdoutWrite: async (text) => {
      stdout.push(text);
    },
    stderrWrite: async (text) => {
      stderr.push(text);
    },
    buildDeps: async (): Promise<Deps> => {
      const fake = makeFakeDeps();
      return {
        ...fake,
        git: makeGitReader({ cwd: repo }),
        fs: makeFsGlob({ cwd: repo }),
        checkRunner: {
          scan: async (screen) => {
            scanned.push(screen.id);
            return fake.checkRunner.scan(screen);
          },
        },
      };
    },
  };
  return { ports, scanned, stdout: () => stdout.join(''), stderr: () => stderr.join('') };
}

describe('the Stop hook checks what CI will check', () => {
  it('scans a UI change the agent committed before it stopped', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    expect(git('status', '--porcelain')).toBe('');

    const h = hook();
    expect(await runStopHookFromStdin('{}', h.ports)).toBe(0);
    expect(h.scanned).toEqual(['home']);
    expect(h.stderr()).not.toContain('IDLE');
    expect(h.stderr()).toContain('VERIFIED');
  });

  it('still scans an uncommitted UI change on top of the committed ones', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('README.md', 'more\n');
    git('commit', '-q', '-am', 'docs only');
    await write('src/App.tsx', 'export const App = 3;\n');

    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual(['home']);
  });

  it('says nothing to check when the branch changed no UI file', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('README.md', 'more\n');
    git('commit', '-q', '-am', 'docs only');

    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual([]);
    expect(h.stderr()).toContain('IDLE');
  });
});
