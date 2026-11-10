/**
 * Doctor reports the history workflow the way it reports the gate: a file that still holds the
 * engine pin placeholder is present but not wired, with the edit that fixes it. The history
 * workflow names the app's default branch, so doctor recognises usabl's own file for any branch it
 * names. Anything else that differs is drifted, never wired.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import { ENGINE_REF_PLACEHOLDER, pinEngineRef } from '../../src/install/ci.js';
import {
  classifyHistoryWorkflow,
  historyWorkflow,
  USABL_HISTORY_WORKFLOW,
  USABL_HISTORY_WORKFLOW_PATH,
} from '../../src/install/history-ci.js';
import { collectDoctorReport, type SurfaceReport } from '../../src/doctor/index.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function readOnlyFs(files: Record<string, string>): InstallFs {
  return {
    readFile: async (path) => files[path] ?? null,
    glob: async (patterns) => Object.keys(files).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async () => {
      throw new Error('doctor must never write');
    },
  };
}

async function historyReport(files: Record<string, string>): Promise<SurfaceReport> {
  const reports = await collectDoctorReport({
    fs: readOnlyFs(files),
    gh: { getJson: async () => null },
    configPath: 'usabl.config.json',
    env: {},
    probePlaywrightChromium: async () => 'wired',
    probeChromiumSandbox: async () => 'available',
  });
  const found = reports.find((report) => report.id === 'history-ci');
  if (found === undefined) throw new Error('no history-ci report');
  return found;
}

describe('classifyHistoryWorkflow', () => {
  it('reads the draft for any plain branch, pinned or not', () => {
    expect(classifyHistoryWorkflow(null)).toBe('missing');
    expect(classifyHistoryWorkflow(USABL_HISTORY_WORKFLOW)).toBe('unpinned');
    expect(classifyHistoryWorkflow(historyWorkflow('trunk'))).toBe('unpinned');
    expect(classifyHistoryWorkflow(pinEngineRef(historyWorkflow('trunk'), SHA))).toBe('wired');
  });

  it('reads any other change as drifted', () => {
    const pinned = pinEngineRef(historyWorkflow('trunk'), SHA);
    expect(classifyHistoryWorkflow(pinned.replace('"17 6 * * *"', '"0 0 * * *"'))).toBe('drifted');
    // The trigger and the scan job must name the same branch.
    expect(classifyHistoryWorkflow(pinned.replace("refs/heads/trunk'", "refs/heads/main'"))).toBe('drifted');
    expect(classifyHistoryWorkflow(pinned.replace('branches: ["trunk"]', 'branches: [trunk]'))).toBe('drifted');
    expect(classifyHistoryWorkflow(pinned.replace('branches: ["trunk"]', 'branches: ["a b"]'))).toBe('drifted');
  });
});

describe('doctor and the history workflow', () => {
  it('reports a history workflow that still holds the placeholder as drifted, with the pin edit', async () => {
    const report = await historyReport({ [USABL_HISTORY_WORKFLOW_PATH]: historyWorkflow('trunk') });

    expect(report.state).toBe('drifted');
    expect(report.nextStep).toContain(ENGINE_REF_PLACEHOLDER);
    expect(report.nextStep).toContain(USABL_HISTORY_WORKFLOW_PATH);
    expect(report.nextStep).toContain('40-character');
    expect(report.nextStep).not.toContain('install --ci');
  });

  it('reports a pinned history workflow as wired', async () => {
    expect((await historyReport({ [USABL_HISTORY_WORKFLOW_PATH]: pinEngineRef(USABL_HISTORY_WORKFLOW, SHA) })).state).toBe('wired');
  });

  it('reports a hand-tuned history workflow as drifted and no file as missing', async () => {
    const tuned = pinEngineRef(USABL_HISTORY_WORKFLOW, SHA).replace('runs-on: ubuntu-latest', 'runs-on: self-hosted');
    expect((await historyReport({ [USABL_HISTORY_WORKFLOW_PATH]: tuned })).state).toBe('drifted');
    expect((await historyReport({})).state).toBe('missing');
  });
});
