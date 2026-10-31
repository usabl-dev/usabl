/**
 * `usabl install --ci` writes the default-branch history workflow beside the gate. The workflow is
 * security-critical in the same way the gate is: the job that runs the application must never hold
 * write access, and the one job that writes must run no application code and never force a push.
 */
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import { countDraftEngineRefLines, EXPECTED_ENGINE_REF_LINES, USABL_GATE_WORKFLOW, USABL_GATE_WORKFLOW_PATH } from '../../src/install/ci.js';
import { installCi, USABL_HISTORY_WORKFLOW, USABL_HISTORY_WORKFLOW_PATH } from '../../src/install/history-ci.js';

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

interface Step { name?: string; run?: string; uses?: string; with?: Record<string, unknown> }
interface Job { permissions?: Record<string, string>; needs?: string; if?: string; steps: Step[] }
const parsed = load(USABL_HISTORY_WORKFLOW) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job> };

describe('the history workflow', () => {
  it('runs on pushes to main, on a schedule, and by hand, and reads only by default', () => {
    expect(Object.keys(parsed.on).sort()).toEqual(['push', 'schedule', 'workflow_dispatch']);
    expect(parsed.on['push']).toEqual({ branches: ['main'] });
    expect(parsed.permissions).toEqual({ contents: 'read' });
  });

  it('scans with read access only, and writes in a job that needs the scan', () => {
    expect(Object.keys(parsed.jobs)).toEqual(['history-scan', 'history-append']);
    expect(parsed.jobs['history-scan']!.permissions).toEqual({ contents: 'read' });
    expect(parsed.jobs['history-append']!.permissions).toEqual({ contents: 'write' });
    expect(parsed.jobs['history-append']!.needs).toBe('history-scan');
  });

  it('runs the application only in the job that cannot write', () => {
    const appendRuns = parsed.jobs['history-append']!.steps.map((step) => step.run ?? '').join('\n');
    const scanRuns = parsed.jobs['history-scan']!.steps.map((step) => step.run ?? '').join('\n');

    expect(scanRuns).toContain('npm run dev');
    expect(scanRuns).toContain('history record --out usabl-history-record.json');
    expect(appendRuns).not.toContain('npm run dev');
    expect(appendRuns).not.toContain('npm ci --ignore-scripts');
    expect(appendRuns).toContain('history append usabl-history-record.json');
  });

  it('never forces a push and never persists the token where the application runs', () => {
    expect(USABL_HISTORY_WORKFLOW).not.toMatch(/push[^\n]*(--force|-f\b|\+refs\/heads\/usabl)/);
    const scanCheckouts = parsed.jobs['history-scan']!.steps.filter((step) => step.uses?.startsWith('actions/checkout'));
    for (const step of scanCheckouts) {
      expect(step.with?.['persist-credentials']).toBe(false);
    }
  });

  it('carries the engine pin sentinel the same number of times as the gate', () => {
    expect(countDraftEngineRefLines(USABL_HISTORY_WORKFLOW)).toBe(EXPECTED_ENGINE_REF_LINES);
  });
});

describe('installCi', () => {
  it('writes the gate and the history workflow, and names the one permission', async () => {
    const fs = memoryFs({});
    const result = await installCi(fs);

    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('written');
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(USABL_GATE_WORKFLOW);
    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(USABL_HISTORY_WORKFLOW);
    expect(result.message).toContain(USABL_HISTORY_WORKFLOW_PATH);
    expect(result.message).toContain('contents: write');
  });

  it('is a no-op on a second run', async () => {
    const fs = memoryFs({});
    await installCi(fs);

    const second = await installCi(fs);

    expect(second).toMatchObject({ exitCode: 0, action: 'already-wired' });
  });

  it('refuses a hand-tuned history workflow without touching it, and still writes the gate', async () => {
    const tuned = USABL_HISTORY_WORKFLOW.replace('"17 6 * * *"', '"0 0 * * *"');
    const fs = memoryFs({ [USABL_HISTORY_WORKFLOW_PATH]: tuned });

    const result = await installCi(fs);

    expect(result.exitCode).toBe(2);
    expect(fs.store[USABL_HISTORY_WORKFLOW_PATH]).toBe(tuned);
    expect(fs.store[USABL_GATE_WORKFLOW_PATH]).toBe(USABL_GATE_WORKFLOW);
  });
});
