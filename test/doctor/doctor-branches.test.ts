/**
 * Doctor reports the docs gate workflow on its own surface, with the same states as the history
 * workflow: missing is optional, the placeholder pin is present but not wired, and any other change
 * is drifted. Each workflow label names the branch its file runs on, and the branch rule label names
 * the branch the check read, or says main was assumed.
 */
import { describe, expect, it } from 'vitest';
import type { InstallFs } from '../../src/install/index.js';
import {
  docsGateWorkflowFor,
  ENGINE_REF_PLACEHOLDER,
  gateWorkflowFor,
  pinEngineRef,
  USABL_DOCS_GATE_WORKFLOW_PATH,
  USABL_GATE_WORKFLOW_PATH,
} from '../../src/install/ci.js';
import { historyWorkflow, USABL_HISTORY_WORKFLOW_PATH } from '../../src/install/history-ci.js';
import { collectDoctorReport, type SurfaceReport } from '../../src/doctor/index.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function readOnlyFs(files: Record<string, string>): InstallFs {
  return {
    readFile: async (path) => files[path] ?? null,
    glob: async () => [],
    writeFile: async () => {
      throw new Error('doctor must never write');
    },
  };
}

async function reports(files: Record<string, string>): Promise<SurfaceReport[]> {
  return collectDoctorReport({
    fs: readOnlyFs(files),
    gh: { getJson: async () => null },
    configPath: 'usabl.config.json',
    env: {},
    probePlaywrightChromium: async () => 'wired',
    probeChromiumSandbox: async () => 'available',
  });
}

function byId(all: SurfaceReport[], id: string): SurfaceReport {
  const found = all.find((report) => report.id === id);
  if (found === undefined) throw new Error(`no ${id} report`);
  return found;
}

describe('the docs gate surface', () => {
  it('reads no docs gate as missing, and says it is optional', async () => {
    const report = byId(await reports({}), 'docs-ci');
    expect(report.state).toBe('missing');
    expect(report.label).toBe(`ci docs gate workflow (${USABL_DOCS_GATE_WORKFLOW_PATH})`);
    expect(report.nextStep).toContain('It is optional');
    expect(report.nextStep).toContain('usabl install --docs-ci');
  });

  it('reads a pinned docs gate for trunk as wired, and names trunk', async () => {
    const report = byId(await reports({ [USABL_DOCS_GATE_WORKFLOW_PATH]: pinEngineRef(docsGateWorkflowFor('trunk'), SHA) }), 'docs-ci');
    expect(report.state).toBe('wired');
    expect(report.label).toBe(`ci docs gate workflow (${USABL_DOCS_GATE_WORKFLOW_PATH}) for pull requests into trunk`);
  });

  it('reads the placeholder pin as drifted, with the pin edit', async () => {
    const report = byId(await reports({ [USABL_DOCS_GATE_WORKFLOW_PATH]: docsGateWorkflowFor('trunk') }), 'docs-ci');
    expect(report.state).toBe('drifted');
    expect(report.nextStep).toContain(ENGINE_REF_PLACEHOLDER);
    expect(report.nextStep).toContain(USABL_DOCS_GATE_WORKFLOW_PATH);
    expect(report.nextStep).not.toContain('install --docs-ci');
  });

  it('reads any other change as drifted, never wired', async () => {
    const tuned = pinEngineRef(docsGateWorkflowFor('trunk'), SHA).replace('runs-on: ubuntu-latest', 'runs-on: self-hosted');
    const report = byId(await reports({ [USABL_DOCS_GATE_WORKFLOW_PATH]: tuned }), 'docs-ci');
    expect(report.state).toBe('drifted');
    expect(report.nextStep).toContain('usabl install --docs-ci');
  });

  it('sits between the app gate and the history workflow', async () => {
    const ids = (await reports({})).map((report) => report.id);
    expect(ids.slice(ids.indexOf('ci'), ids.indexOf('branch-rule') + 1)).toEqual(['ci', 'docs-ci', 'history-ci', 'branch-rule']);
  });
});

describe('labels name the real branch', () => {
  it('names the branch each workflow file runs on', async () => {
    const all = await reports({
      [USABL_GATE_WORKFLOW_PATH]: pinEngineRef(gateWorkflowFor('trunk'), SHA),
      [USABL_HISTORY_WORKFLOW_PATH]: pinEngineRef(historyWorkflow('trunk'), SHA),
    });
    expect(byId(all, 'ci').label).toBe(`ci gate workflow (${USABL_GATE_WORKFLOW_PATH}) for pull requests into trunk`);
    expect(byId(all, 'history-ci').label).toBe(`ci history workflow (${USABL_HISTORY_WORKFLOW_PATH}) for pushes to trunk`);
    expect(byId(all, 'branch-rule').label).toBe('branch protection (trunk requires usabl-required)');
  });

  it('names no branch for a file whose trigger it cannot read, and says main was assumed', async () => {
    const drifted = pinEngineRef(gateWorkflowFor('trunk'), SHA).replace('    branches: ["trunk"]', '    branches: [trunk]');
    const all = await reports({ [USABL_GATE_WORKFLOW_PATH]: drifted });
    expect(byId(all, 'ci').label).toBe(`ci gate workflow (${USABL_GATE_WORKFLOW_PATH})`);
    expect(byId(all, 'ci').state).toBe('drifted');
    expect(byId(all, 'branch-rule').label).toBe('branch protection (main, assumed, requires usabl-required)');
  });

  it('says main was assumed when there is no gate workflow', async () => {
    expect(byId(await reports({}), 'branch-rule').label).toBe('branch protection (main, assumed, requires usabl-required)');
  });
});
