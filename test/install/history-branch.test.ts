/**
 * The history workflow runs on pushes to the app's default branch, which is not always main. The
 * installer reads that branch from git and writes it into the trigger and the scan job's `if:`,
 * and says which branch it wrote. When git cannot name it, or names one with a character outside
 * letters, digits, and . _ - /, the installer writes main and prints a step to change it. A re-run
 * still recognises its own file, whatever branch it names.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import type { EnginePin } from '../../src/install/build-info.js';
import { pinEngineRef, USABL_GATE_WORKFLOW, USABL_GATE_WORKFLOW_PATH } from '../../src/install/ci.js';
import {
  historyWorkflow,
  installCi,
  USABL_HISTORY_WORKFLOW,
  USABL_HISTORY_WORKFLOW_PATH,
} from '../../src/install/history-ci.js';
import { gitRunner, NO_GIT } from '../../src/install/repo-git.js';
import { fakeGit } from './fake-git.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const FILLED: EnginePin = { kind: 'filled', sha: SHA, version: '0.3.0' };
const CONFIG = JSON.stringify({ appBaseUrl: 'http://127.0.0.1:9000' });
const APP = { 'usabl.config.json': CONFIG, 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) };

function memoryFs(files: Record<string, string>): InstallFs & { store: Record<string, string> } {
  const store = { ...files };
  return {
    readFile: async (path) => store[path] ?? null,
    glob: async (patterns) => Object.keys(store).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async (path, contents) => {
      store[path] = contents;
    },
    store,
  };
}

interface Parsed { on: { push: { branches: string[] } }; jobs: Record<string, { if?: string }> }
const parse = (text: string): Parsed => load(text) as Parsed;

const lineOf = (text: string, pattern: RegExp): number => text.split('\n').findIndex((line) => pattern.test(line)) + 1;
// The gate takes its branch the same way, so one step names the lines in both files.
const checkBranchStep = (reason: string): string =>
  `Check the branch name. usabl could not find your default branch, because ${reason}. So ${USABL_GATE_WORKFLOW_PATH} runs on pull requests into main, and ${USABL_HISTORY_WORKFLOW_PATH} runs on pushes to main. If your default branch has another name, put it in place of main on line ${lineOf(USABL_GATE_WORKFLOW, /^ {4}branches:/)} of ${USABL_GATE_WORKFLOW_PATH} and lines ${lineOf(USABL_HISTORY_WORKFLOW, /^ {4}branches:/)} and ${lineOf(USABL_HISTORY_WORKFLOW, /^ {4}if: github\.ref/)} of ${USABL_HISTORY_WORKFLOW_PATH}.`;

describe('historyWorkflow', () => {
  it('names the branch in the trigger and in the scan job, and nowhere else changes', () => {
    const trunk = historyWorkflow('trunk');
    expect(parse(trunk).on.push.branches).toEqual(['trunk']);
    expect(parse(trunk).jobs['history-scan']!.if).toBe("github.ref == 'refs/heads/trunk'");
    expect(trunk.split('\n')).toHaveLength(USABL_HISTORY_WORKFLOW.split('\n').length);
    expect(parse(USABL_HISTORY_WORKFLOW).on.push.branches).toEqual(['main']);
  });

  it('refuses a name with any character outside letters, digits, and . _ - /', () => {
    for (const name of ['a b', 'x"y', "x'y", '$(id)', 'main\n  evil: 1', 'feat+1', '']) {
      expect(() => historyWorkflow(name), JSON.stringify(name)).toThrow();
    }
  });
});

describe('installCi writes the default branch git names', () => {
  it('writes trunk, says so, and prints no branch step', async () => {
    const fs = memoryFs(APP);
    const result = await installCi(fs, FILLED, fakeGit('trunk', { 'usabl.config.json': CONFIG }));

    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(pinEngineRef(historyWorkflow('trunk'), SHA));
    expect(result.message).toContain(`${USABL_HISTORY_WORKFLOW_PATH} runs on pushes to trunk, the default branch git records for origin.`);
    expect(result.message).not.toContain('Check the branch name');
  });

  it('writes main and prints the step to change it when there is no default branch to read', async () => {
    const fs = memoryFs(APP);
    const result = await installCi(fs, FILLED, NO_GIT);

    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(pinEngineRef(USABL_HISTORY_WORKFLOW, SHA));
    expect(result.message).toContain(checkBranchStep('git has no default branch recorded for origin (refs/remotes/origin/HEAD is not set; "git remote set-head origin --auto" records it)'));
  });

  it('treats a name outside the safe pattern as not found', async () => {
    for (const name of ['feat+1', 'a b', 'x"y', "x'y", '$(id)', 'main\n    evil: 1']) {
      const fs = memoryFs(APP);
      const result = await installCi(fs, FILLED, fakeGit(name));
      expect(fs.store[USABL_HISTORY_WORKFLOW_PATH], JSON.stringify(name)).toBe(pinEngineRef(USABL_HISTORY_WORKFLOW, SHA));
      expect(result.message).toContain('Check the branch name.');
    }
  });

  it('recognises its own file on a re-run, whatever branch it names', async () => {
    const fs = memoryFs(APP);
    await installCi(fs, FILLED, fakeGit('trunk'));
    const written = fs.store[USABL_HISTORY_WORKFLOW_PATH];

    // The same lookup again, and then a run where git cannot name the branch: both leave it alone.
    for (const git of [fakeGit('trunk'), NO_GIT]) {
      const again = await installCi(fs, FILLED, git);
      expect(again.exitCode).toBe(0);
      expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(written);
      expect(again.message).toContain(`${USABL_HISTORY_WORKFLOW_PATH} already matches the usabl history workflow. No change.`);
    }
  });

  it('fills the pin in its own placeholder draft for another branch', async () => {
    const fs = memoryFs({ ...APP, [USABL_HISTORY_WORKFLOW_PATH]: historyWorkflow('develop') });
    const result = await installCi(fs, FILLED, NO_GIT);

    expect(result.exitCode).toBe(0);
    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(pinEngineRef(historyWorkflow('develop'), SHA));
  });

  it('says so when the file names a branch other than the default branch git records', async () => {
    const fs = memoryFs({ ...APP, [USABL_HISTORY_WORKFLOW_PATH]: pinEngineRef(USABL_HISTORY_WORKFLOW, SHA) });
    const result = await installCi(fs, FILLED, fakeGit('trunk'));

    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(pinEngineRef(USABL_HISTORY_WORKFLOW, SHA));
    expect(result.message).toContain(
      `${USABL_HISTORY_WORKFLOW_PATH} runs on pushes to main, but the default branch git records for origin is trunk. Put trunk in place of main on lines ${lineOf(USABL_HISTORY_WORKFLOW, /^ {4}branches:/)} and ${lineOf(USABL_HISTORY_WORKFLOW, /^ {4}if: github\.ref/)}, or the history scan never runs.`,
    );
  });
});

describe('installCi on real repositories', () => {
  let work: string;

  function git(cwd: string, args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  async function seed(dir: string, branch: string): Promise<void> {
    git(work, ['init', '--quiet', '-b', branch, dir]);
    git(dir, ['config', 'user.name', 'usabl history branch test']);
    git(dir, ['config', 'user.email', 'history-branch@usabl.invalid']);
    await writeFile(join(dir, 'usabl.config.json'), CONFIG);
    git(dir, ['add', '.']);
    git(dir, ['commit', '--quiet', '-m', 'seed']);
  }

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'usabl-history-branch-'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('writes trunk for a clone whose default branch is trunk', async () => {
    await seed(join(work, 'upstream'), 'trunk');
    git(work, ['clone', '--quiet', join(work, 'upstream'), 'app']);

    const fs = memoryFs(APP);
    const result = await installCi(fs, FILLED, gitRunner(join(work, 'app')));

    expect(parse(fs.store[USABL_HISTORY_WORKFLOW_PATH] ?? '').on.push.branches).toEqual(['trunk']);
    expect(result.message).toContain('runs on pushes to trunk');
    // The clone's trunk holds the same config bytes, so the config-first step is left out.
    expect(result.message).not.toContain('first, in its own pull request');
  });

  it('writes main and prints the step for a default branch name outside the pattern', async () => {
    await seed(join(work, 'upstream'), 'release+1');
    git(work, ['clone', '--quiet', join(work, 'upstream'), 'app']);

    const fs = memoryFs(APP);
    const result = await installCi(fs, FILLED, gitRunner(join(work, 'app')));

    expect(parse(fs.store[USABL_HISTORY_WORKFLOW_PATH] ?? '').on.push.branches).toEqual(['main']);
    expect(result.message).toContain('Check the branch name.');
    expect(result.message).toContain('Merge usabl.config.json to your default branch first');
  });

  it('writes main and prints the step for a repository with no remote', async () => {
    await seed(join(work, 'app'), 'trunk');

    const fs = memoryFs(APP);
    const result = await installCi(fs, FILLED, gitRunner(join(work, 'app')));

    expect(parse(fs.store[USABL_HISTORY_WORKFLOW_PATH] ?? '').on.push.branches).toEqual(['main']);
    expect(result.message).toContain('Check the branch name.');
  });
});
