/**
 * An earlier 0.3.0 build wrote workflows this version does not run as written: the gates trigger on
 * `branches: [main]`, unquoted, and some comments and step names differ. Such a file, unedited, is
 * usabl's own text, so `usabl install --ci` and `--docs-ci` rewrite it to this draft, keep the
 * engine pin it held, and say so. A file that is the earlier draft with any edit is still refused.
 * The fixtures are the exact bytes the build at that commit wrote.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import type { EnginePin } from '../../src/install/build-info.js';
import {
  classifyGateWorkflow,
  docsGateWorkflowFor,
  EARLIER_DOCS_GATE_WORKFLOW,
  EARLIER_GATE_WORKFLOW,
  ENGINE_REF_PLACEHOLDER,
  gateWorkflowFor,
  pinEngineRef,
  USABL_DOCS_GATE_WORKFLOW_PATH,
  USABL_GATE_WORKFLOW_PATH,
} from '../../src/install/ci.js';
import { earlierHistoryWorkflow, historyWorkflow, installCi, USABL_HISTORY_WORKFLOW_PATH } from '../../src/install/history-ci.js';
import { installDocsCi } from '../../src/install/docs-ci.js';
import { NO_GIT } from '../../src/install/repo-git.js';
import { collectDoctorReport } from '../../src/doctor/index.js';
import { fakeGit } from './fake-git.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const FILLED: EnginePin = { kind: 'filled', sha: SHA, version: '0.3.0' };
const DIRTY: EnginePin = { kind: 'placeholder', reason: 'this usabl was built outside git' };
const CONFIG = JSON.stringify({ appBaseUrl: 'http://127.0.0.1:9000' });
const APP = { 'usabl.config.json': CONFIG, 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) };

const fixture = (name: string): string => readFileSync(new URL(`../../fixtures/install/earlier-0.3.0/${name}`, import.meta.url), 'utf8');
const EARLIER_GATE_BYTES = fixture('usabl-gate.yml');
const EARLIER_DOCS_BYTES = fixture('usabl-docs-gate.yml');
const EARLIER_HISTORY_TRUNK_BYTES = fixture('usabl-history-trunk.yml');

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

describe('the earlier forms usabl recognises', () => {
  it('are byte for byte what the earlier build wrote', () => {
    expect(EARLIER_GATE_WORKFLOW).toBe(EARLIER_GATE_BYTES);
    expect(EARLIER_DOCS_GATE_WORKFLOW).toBe(EARLIER_DOCS_BYTES);
    expect(earlierHistoryWorkflow('trunk')).toBe(EARLIER_HISTORY_TRUNK_BYTES);
  });

  it('are not this draft, so doctor reads them as drifted, never wired', () => {
    expect(classifyGateWorkflow(pinEngineRef(EARLIER_GATE_BYTES, SHA))).toBe('drifted');
  });
});

describe('install rewrites an unedited earlier draft and keeps its pin', () => {
  it('rewrites the gate and the history workflow pinned to the commit they held', async () => {
    const fs = memoryFs({
      ...APP,
      [USABL_GATE_WORKFLOW_PATH]: pinEngineRef(EARLIER_GATE_BYTES, OTHER_SHA),
      [USABL_HISTORY_WORKFLOW_PATH]: pinEngineRef(EARLIER_HISTORY_TRUNK_BYTES, OTHER_SHA),
    });
    const result = await installCi(fs, FILLED, fakeGit('trunk', { 'usabl.config.json': CONFIG }));

    expect(result.exitCode).toBe(0);
    // The earlier gate could only name main. It now names the default branch git records.
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(gateWorkflowFor('trunk'), OTHER_SHA));
    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(pinEngineRef(historyWorkflow('trunk'), OTHER_SHA));
    expect(result.message).toContain(
      `Rewrote ${USABL_GATE_WORKFLOW_PATH}. It held the unedited draft an earlier 0.3.0 build wrote, which this version does not recognise. The engine pin ${OTHER_SHA} is kept. Review the change before you commit it.`,
    );
    expect(result.message).toContain(`Rewrote ${USABL_HISTORY_WORKFLOW_PATH}.`);
    expect(result.message).toContain(`Review and commit ${USABL_GATE_WORKFLOW_PATH} and ${USABL_HISTORY_WORKFLOW_PATH}.`);
  });

  it('keeps the branch an earlier history workflow names, even when git names none', async () => {
    const fs = memoryFs({ ...APP, [USABL_HISTORY_WORKFLOW_PATH]: EARLIER_HISTORY_TRUNK_BYTES });
    await installCi(fs, FILLED, NO_GIT);
    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(pinEngineRef(historyWorkflow('trunk'), SHA));
  });

  it('fills the pin in an earlier placeholder draft, or keeps the placeholder without a commit', async () => {
    const filled = memoryFs({ ...APP, [USABL_GATE_WORKFLOW_PATH]: EARLIER_GATE_BYTES });
    await installCi(filled, FILLED, NO_GIT);
    expect(filled.store[USABL_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(gateWorkflowFor('main'), SHA));

    const dirty = memoryFs({ ...APP, [USABL_GATE_WORKFLOW_PATH]: EARLIER_GATE_BYTES });
    const result = await installCi(dirty, DIRTY, NO_GIT);
    expect(dirty.store[USABL_GATE_WORKFLOW_PATH]).toBe(gateWorkflowFor('main'));
    expect(result.message).toContain(`Pin the engine. The engine ref is still the placeholder ${ENGINE_REF_PLACEHOLDER}`);
  });

  it('rewrites an earlier docs gate', async () => {
    const fs = memoryFs({ [USABL_DOCS_GATE_WORKFLOW_PATH]: pinEngineRef(EARLIER_DOCS_BYTES, OTHER_SHA) });
    const result = await installDocsCi(fs, FILLED, fakeGit('trunk'));
    expect(fs.store[USABL_DOCS_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(docsGateWorkflowFor('trunk'), OTHER_SHA));
    expect(result.message).toContain(`Rewrote ${USABL_DOCS_GATE_WORKFLOW_PATH}.`);
  });

  it('still refuses an earlier draft with any edit, and writes nothing over it', async () => {
    const pinned = pinEngineRef(EARLIER_GATE_BYTES, OTHER_SHA);
    for (const edited of [
      pinned.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted'),
      pinned.replace('    branches: [main]', '    branches: [develop]'),
      pinned.replace('    branches: [main]', '    branches: ["main"]'),
      `${pinned}\n`,
      EARLIER_GATE_BYTES.replace(`ref: ${ENGINE_REF_PLACEHOLDER}`, 'ref: v0.3.0'),
    ]) {
      const fs = memoryFs({ ...APP, [USABL_GATE_WORKFLOW_PATH]: edited });
      const result = await installCi(fs, FILLED, fakeGit('trunk'));
      expect(result.exitCode).toBe(2);
      expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(edited);
    }
  });
});

describe('doctor and an earlier draft', () => {
  it('reads it as drifted and says install rewrites it', async () => {
    const files: Record<string, string> = { [USABL_GATE_WORKFLOW_PATH]: pinEngineRef(EARLIER_GATE_BYTES, OTHER_SHA) };
    const reports = await collectDoctorReport({
      fs: {
        readFile: async (path) => files[path] ?? null,
        glob: async () => [],
        writeFile: async () => {
          throw new Error('doctor must never write');
        },
      },
      gh: { getJson: async () => null },
      configPath: 'usabl.config.json',
      env: {},
      probePlaywrightChromium: async () => 'wired',
      probeChromiumSandbox: async () => 'available',
    });
    const ci = reports.find((report) => report.id === 'ci');
    expect(ci?.state).toBe('drifted');
    expect(ci?.nextStep).toBe(
      'The gate workflow is the unedited draft an earlier 0.3.0 build wrote, which this version does not recognise. Run "usabl install --ci": it rewrites the file and keeps its engine pin.',
    );
  });
});
