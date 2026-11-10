/**
 * The gate, the docs gate, and the history workflow must all name the default branch. When the
 * files on disk name different branches, install says so in one step that names each file and its
 * branch. It never rewrites a file to make them agree.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import type { EnginePin } from '../../src/install/build-info.js';
import {
  docsGateWorkflowFor,
  gateWorkflowFor,
  pinEngineRef,
  USABL_DOCS_GATE_WORKFLOW_PATH,
  USABL_GATE_WORKFLOW_PATH,
} from '../../src/install/ci.js';
import { historyWorkflow, installCi, USABL_HISTORY_WORKFLOW_PATH } from '../../src/install/history-ci.js';
import { installDocsCi } from '../../src/install/docs-ci.js';
import { NO_GIT } from '../../src/install/repo-git.js';
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

const agreementSteps = (message: string): string[] =>
  message.split('\n').filter((line) => line.includes('The usabl workflows name different branches'));

const AGREE_TAIL =
  'Each one must name your default branch, or one of them runs on the wrong branch. usabl does not change a file to make them agree. Edit the branch name in each file that is wrong, then run this command again.';

describe('install says when the usabl workflows name different branches', () => {
  it('names each file and its branch in one step, and rewrites neither', async () => {
    const gate = pinEngineRef(gateWorkflowFor('main'), SHA);
    const history = pinEngineRef(historyWorkflow('trunk'), SHA);
    const fs = memoryFs({ ...APP, [USABL_GATE_WORKFLOW_PATH]: gate, [USABL_HISTORY_WORKFLOW_PATH]: history });

    const result = await installCi(fs, FILLED, fakeGit('trunk', { 'usabl.config.json': CONFIG }));

    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(gate);
    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(history);
    const steps = agreementSteps(result.message);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatch(
      new RegExp(
        `^\\d+\\. The usabl workflows name different branches: ${USABL_GATE_WORKFLOW_PATH} names main, and ${USABL_HISTORY_WORKFLOW_PATH} names trunk\\. `,
      ),
    );
    expect(steps[0]).toContain(AGREE_TAIL);
  });

  it('says nothing when every file names the same branch', async () => {
    const fs = memoryFs(APP);
    const first = await installCi(fs, FILLED, fakeGit('trunk'));
    expect(agreementSteps(first.message)).toEqual([]);
    // The docs gate, written later for the same branch, agrees too.
    const docs = await installDocsCi(fs, FILLED, fakeGit('trunk'));
    expect(agreementSteps(docs.message)).toEqual([]);
  });

  it('names the docs gate and the app gate files from install --docs-ci', async () => {
    const fs = memoryFs({
      ...APP,
      [USABL_GATE_WORKFLOW_PATH]: pinEngineRef(gateWorkflowFor('main'), SHA),
      [USABL_HISTORY_WORKFLOW_PATH]: pinEngineRef(historyWorkflow('main'), SHA),
    });
    const result = await installDocsCi(fs, FILLED, fakeGit('trunk'));

    expect(fs.store[USABL_DOCS_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(docsGateWorkflowFor('trunk'), SHA));
    const steps = agreementSteps(result.message);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain(
      `${USABL_GATE_WORKFLOW_PATH} names main, ${USABL_DOCS_GATE_WORKFLOW_PATH} names trunk, and ${USABL_HISTORY_WORKFLOW_PATH} names main.`,
    );
  });

  it('leaves out a file whose trigger names no branch usabl can read', async () => {
    const unreadable = pinEngineRef(gateWorkflowFor('develop'), SHA).replace('    branches: ["develop"]', '    branches: [develop]');
    const fs = memoryFs({ ...APP, [USABL_GATE_WORKFLOW_PATH]: unreadable });
    const result = await installCi(fs, FILLED, NO_GIT);

    // The gate is refused as hand-tuned, the history workflow is written for main, and the gate's
    // trigger cannot be read, so there is nothing to compare.
    expect(result.exitCode).toBe(2);
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(unreadable);
    expect(agreementSteps(result.message)).toEqual([]);
  });

  it('compares the branch each file names even when one file is refused', async () => {
    const tuned = pinEngineRef(gateWorkflowFor('develop'), SHA).replace('runs-on: ubuntu-latest', 'runs-on: self-hosted');
    const fs = memoryFs({ ...APP, [USABL_GATE_WORKFLOW_PATH]: tuned });
    const result = await installCi(fs, FILLED, fakeGit('trunk'));

    expect(result.exitCode).toBe(2);
    expect(agreementSteps(result.message)[0]).toContain(`${USABL_GATE_WORKFLOW_PATH} names develop, and ${USABL_HISTORY_WORKFLOW_PATH} names trunk.`);
  });
});
