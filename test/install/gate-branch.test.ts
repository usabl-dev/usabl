/**
 * The pull request gate runs on pull requests into the app's default branch, which is not always
 * main. It takes that branch the same way the history workflow does: from the clone's origin/HEAD,
 * only a plain name, written quoted, main and a printed step when git cannot name one, and a
 * branch already in usabl's own file kept on a re-run. The file then names the branch, and the
 * classifier recognises usabl's own draft for whichever plain branch the trigger names.
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
import {
  classifyGateWorkflow,
  gateWorkflowFor,
  pinEngineRef,
  USABL_GATE_WORKFLOW,
  USABL_GATE_WORKFLOW_PATH,
} from '../../src/install/ci.js';
import { historyWorkflow, installCi, USABL_HISTORY_WORKFLOW, USABL_HISTORY_WORKFLOW_PATH } from '../../src/install/history-ci.js';
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

interface Parsed {
  on: { pull_request: { branches: string[] }; pull_request_review: Record<string, unknown> };
}
const parse = (text: string): Parsed => load(text) as Parsed;
const lineOf = (text: string, pattern: RegExp): number => text.split('\n').findIndex((line) => pattern.test(line)) + 1;
const differingLines = (a: string, b: string): number[] =>
  a.split('\n').flatMap((line, index) => (line === b.split('\n')[index] ? [] : [index + 1]));

describe('gateWorkflowFor', () => {
  it('names the branch in the pull request trigger only, written quoted', () => {
    const trunk = gateWorkflowFor('trunk');
    expect(parse(trunk).on.pull_request.branches).toEqual(['trunk']);
    expect(trunk).toContain('  pull_request:\n    branches: ["trunk"]\n');
    // The only line that changes with the branch is the trigger.
    expect(differingLines(trunk, gateWorkflowFor('main'))).toEqual([lineOf(trunk, /^ {4}branches:/)]);
    expect(USABL_GATE_WORKFLOW).toBe(gateWorkflowFor('main'));
    // A name that looks like a number is still text to YAML, because it is quoted.
    expect(parse(gateWorkflowFor('2024')).on.pull_request.branches).toEqual(['2024']);
  });

  it('refuses a name with any character outside letters, digits, and . _ - /', () => {
    for (const name of ['a b', 'x"y', "x'y", '$(id)', 'main\n    evil: 1', 'feat+1', '']) {
      expect(() => gateWorkflowFor(name), JSON.stringify(name)).toThrow();
    }
  });
});

describe('classifyGateWorkflow reads the branch the file names', () => {
  it('recognises the draft for any plain branch, pinned or not', () => {
    expect(classifyGateWorkflow(gateWorkflowFor('trunk'))).toBe('unpinned');
    expect(classifyGateWorkflow(pinEngineRef(gateWorkflowFor('trunk'), SHA))).toBe('wired');
    expect(classifyGateWorkflow(pinEngineRef(gateWorkflowFor('release/2.x'), SHA))).toBe('wired');
  });

  it('reads every near miss of the trigger as drifted, never wired', () => {
    const pinned = pinEngineRef(gateWorkflowFor('trunk'), SHA);
    const trigger = '    branches: ["trunk"]';
    for (const line of [
      '    branches: [trunk]',
      "    branches: ['trunk']",
      '    branches: ["a b"]',
      '    branches: ["trunk", "main"]',
      '    branches: ["trunk"] ',
      '     branches: ["trunk"]',
      '    branches: [""]',
    ]) {
      expect(classifyGateWorkflow(pinned.replace(trigger, line)), line).toBe('drifted');
    }
    // The trigger moved under the review event is not the draft.
    const moved = pinned
      .replace('  pull_request:\n    branches: ["trunk"]\n', '  pull_request:\n')
      .replace('  pull_request_review:\n', '  pull_request_review:\n    branches: ["trunk"]\n');
    expect(classifyGateWorkflow(moved)).toBe('drifted');
  });
});

describe('installCi writes the gate for the default branch git names', () => {
  it('writes trunk into the gate and the history workflow, and says so for each', async () => {
    const fs = memoryFs(APP);
    const result = await installCi(fs, FILLED, fakeGit('trunk', { 'usabl.config.json': CONFIG }));

    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(gateWorkflowFor('trunk'), SHA));
    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(pinEngineRef(historyWorkflow('trunk'), SHA));
    expect(result.message).toContain(`${USABL_GATE_WORKFLOW_PATH} runs on pull requests into trunk, the default branch git records for origin.`);
    expect(result.message).not.toContain('Check the branch name');
  });

  it('writes main and prints one step naming the line in each file when git names no branch', async () => {
    const fs = memoryFs(APP);
    const result = await installCi(fs, FILLED, NO_GIT);

    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(USABL_GATE_WORKFLOW, SHA));
    const steps = result.message.split('\n').filter((line) => line.includes('Check the branch name.'));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain(
      `So ${USABL_GATE_WORKFLOW_PATH} runs on pull requests into main, and ${USABL_HISTORY_WORKFLOW_PATH} runs on pushes to main. If your default branch has another name, put it in place of main on line ${lineOf(USABL_GATE_WORKFLOW, /^ {4}branches:/)} of ${USABL_GATE_WORKFLOW_PATH} and lines ${lineOf(USABL_HISTORY_WORKFLOW, /^ {4}branches:/)} and ${lineOf(USABL_HISTORY_WORKFLOW, /^ {4}if: github\.ref/)} of ${USABL_HISTORY_WORKFLOW_PATH}.`,
    );
  });

  it('treats a name outside the safe pattern as not found', async () => {
    for (const name of ['feat+1', 'a b', 'x"y', '$(id)']) {
      const fs = memoryFs(APP);
      const result = await installCi(fs, FILLED, fakeGit(name));
      expect(fs.store[USABL_GATE_WORKFLOW_PATH], JSON.stringify(name)).toBe(pinEngineRef(USABL_GATE_WORKFLOW, SHA));
      expect(result.message).toContain('Check the branch name.');
    }
  });

  it('keeps the branch its own file names on a re-run, whatever git says now', async () => {
    const fs = memoryFs(APP);
    await installCi(fs, FILLED, fakeGit('trunk'));
    const written = fs.store[USABL_GATE_WORKFLOW_PATH];

    for (const git of [fakeGit('trunk'), NO_GIT, fakeGit('develop')]) {
      const again = await installCi(fs, FILLED, git);
      expect(again.exitCode).toBe(0);
      expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(written);
      expect(again.message).toContain(`${USABL_GATE_WORKFLOW_PATH} already matches the usabl gate workflow. No change.`);
    }
  });

  it('fills the pin in its own placeholder draft for another branch', async () => {
    const fs = memoryFs({ ...APP, [USABL_GATE_WORKFLOW_PATH]: gateWorkflowFor('develop') });
    const result = await installCi(fs, FILLED, NO_GIT);

    expect(result.exitCode).toBe(0);
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(gateWorkflowFor('develop'), SHA));
  });

  it('says so when the gate names a branch other than the default branch git records', async () => {
    const fs = memoryFs({ ...APP, [USABL_GATE_WORKFLOW_PATH]: pinEngineRef(USABL_GATE_WORKFLOW, SHA) });
    const result = await installCi(fs, FILLED, fakeGit('trunk'));

    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(USABL_GATE_WORKFLOW, SHA));
    expect(result.message).toContain(
      `${USABL_GATE_WORKFLOW_PATH} runs on pull requests into main, but the default branch git records for origin is trunk. Put trunk in place of main on line ${lineOf(USABL_GATE_WORKFLOW, /^ {4}branches:/)}, or the gate never runs and "usabl-required" never reports.`,
    );
  });

  it('refuses a hand-tuned gate for any branch, and writes nothing over it', async () => {
    const tuned = pinEngineRef(gateWorkflowFor('trunk'), SHA).replace('runs-on: ubuntu-latest', 'runs-on: self-hosted');
    const fs = memoryFs({ ...APP, [USABL_GATE_WORKFLOW_PATH]: tuned });
    const result = await installCi(fs, FILLED, fakeGit('trunk'));

    expect(result.exitCode).toBe(2);
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(tuned);
  });
});

describe('installCi on a real clone whose default branch is trunk', () => {
  let work: string;

  function git(cwd: string, args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'usabl-gate-branch-'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('writes trunk into the gate trigger', async () => {
    const upstream = join(work, 'upstream');
    git(work, ['init', '--quiet', '-b', 'trunk', upstream]);
    git(upstream, ['config', 'user.name', 'usabl gate branch test']);
    git(upstream, ['config', 'user.email', 'gate-branch@usabl.invalid']);
    await writeFile(join(upstream, 'usabl.config.json'), CONFIG);
    git(upstream, ['add', '.']);
    git(upstream, ['commit', '--quiet', '-m', 'seed']);
    git(work, ['clone', '--quiet', upstream, 'app']);

    const fs = memoryFs(APP);
    await installCi(fs, FILLED, gitRunner(join(work, 'app')));

    expect(parse(fs.store[USABL_GATE_WORKFLOW_PATH] ?? '').on.pull_request.branches).toEqual(['trunk']);
  });
});
