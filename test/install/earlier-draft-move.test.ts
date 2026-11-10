/**
 * When install rewrites an earlier 0.3.0 gate, the earlier gate named main, and the rewrite names the
 * default branch git records for origin. origin/HEAD is set when the clone is made and is not updated
 * when a team renames its default branch, so it can be stale. The rewrite line therefore says when the
 * trigger moved, from which branch to which, how to put it back, and that the person must commit the
 * file.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import type { EnginePin } from '../../src/install/build-info.js';
import { docsGateWorkflowFor, gateWorkflowFor, pinEngineRef, USABL_DOCS_GATE_WORKFLOW_PATH, USABL_GATE_WORKFLOW_PATH } from '../../src/install/ci.js';
import { installCi } from '../../src/install/history-ci.js';
import { installDocsCi } from '../../src/install/docs-ci.js';
import { fakeGit } from './fake-git.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const FILLED: EnginePin = { kind: 'filled', sha: SHA, version: '0.3.0' };
const CONFIG = JSON.stringify({ appBaseUrl: 'http://127.0.0.1:9000' });
const APP = { 'usabl.config.json': CONFIG, 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) };

const fixture = (name: string): string => readFileSync(new URL(`../../fixtures/install/earlier-0.3.0/${name}`, import.meta.url), 'utf8');
const EARLIER_GATE_BYTES = fixture('usabl-gate.yml');
const EARLIER_DOCS_BYTES = fixture('usabl-docs-gate.yml');

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

describe('the rewrite of an earlier gate', () => {
  it('says the trigger moved from main to master when a stale origin/HEAD names master', async () => {
    const fs = memoryFs({ ...APP, [USABL_GATE_WORKFLOW_PATH]: pinEngineRef(EARLIER_GATE_BYTES, OTHER_SHA) });
    const result = await installCi(fs, FILLED, fakeGit('master', { 'usabl.config.json': CONFIG }));
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(gateWorkflowFor('master'), OTHER_SHA));
    expect(result.message).toContain(
      `Rewrote ${USABL_GATE_WORKFLOW_PATH}. It held the unedited draft an earlier 0.3.0 build wrote, which this version does not recognise. ` +
        'Its trigger moved from main to master, the default branch git records for origin. If main is still your default branch, put main back in place of master on line 8. ' +
        `The engine pin ${OTHER_SHA} is kept. Review the file and commit it: the change is only on disk until you do.`,
    );
  });

  it('says nothing moved when git also names main, and still says to commit the file', async () => {
    const fs = memoryFs({ ...APP, [USABL_GATE_WORKFLOW_PATH]: pinEngineRef(EARLIER_GATE_BYTES, OTHER_SHA) });
    const result = await installCi(fs, FILLED, fakeGit('main', { 'usabl.config.json': CONFIG }));
    const line = result.message.split('\n').find((entry) => entry.includes(`Rewrote ${USABL_GATE_WORKFLOW_PATH}.`));
    expect(line).toBe(
      `Rewrote ${USABL_GATE_WORKFLOW_PATH}. It held the unedited draft an earlier 0.3.0 build wrote, which this version does not recognise. The engine pin ${OTHER_SHA} is kept. Review the file and commit it: the change is only on disk until you do.`,
    );
  });

  it('says the trigger moved in an earlier docs gate too', async () => {
    const fs = memoryFs({ [USABL_DOCS_GATE_WORKFLOW_PATH]: EARLIER_DOCS_BYTES });
    const result = await installDocsCi(fs, FILLED, fakeGit('master'));
    expect(fs.store[USABL_DOCS_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(docsGateWorkflowFor('master'), SHA));
    expect(result.message).toContain('Its trigger moved from main to master, the default branch git records for origin.');
    expect(result.message).not.toContain('The engine pin');
  });
});
