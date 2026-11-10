import { describe, expect, it } from 'vitest';
import type { Deps, Draft, Result, ScreenScan, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { run } from '../../src/run.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import { runStopHookFromStdin } from '../../src/surfaces/stop-hook-runner.js';
import { committedConfigBytes } from '../support/config-bytes.js';
import { memoryPinStore } from '../support/memory-pin-store.js';

// Hook level: the stop hook's fast path allows on a stored receipt. A receipt minted while a waiver
// was live must answer VERIFIED only until that waiver ends. From that moment the hook runs a full
// check, which counts the accessibility barrier again and blocks the stop on it.

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

const MINTED = '2026-03-01T00:00:00.000Z';
const EXPIRES = '2026-06-01T00:00:00.000Z';

const failDraft: Draft = {
  rule: 'color-contrast',
  layer: 'axe',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'clusters',
  elementPath: 'button',
  elementName: 'Save',
  role: 'button',
  whatUserExperiences: 'Save is hard to read',
  why: 'contrast too low',
  fix: 'Increase contrast',
  evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
  confidence: 'fail',
};

const scan: ScreenScan = {
  screenId: 'clusters',
  url: config.surfaces[0]!.url,
  stops: [],
  drafts: [failDraft],
  gaps: [],
  applicability: [],
  reachedSelectorPresent: null,
};

function depsAt(now: string, waivers: unknown[]): Deps {
  const files = {
    'usabl.config.json': JSON.stringify(config),
    'usabl.routes.json': JSON.stringify({ routes: [] }),
    '.usabl-evidence.json': JSON.stringify({ version: 2, entries: [] }),
    '.usabl-waivers.json': JSON.stringify({ version: 1, waivers }),
  };
  return makeFakeDeps({
    now,
    files,
    headContents: { ...files },
    headBlobs: { 'usabl.config.json': 'blob-config', '.usabl-waivers.json': 'blob-waivers' },
    writeTree: 'tree-a',
    changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
    scans: { clusters: scan },
  });
}

const liveWaiver = {
  rule: 'color-contrast',
  surface: 'clusters',
  scope: '*',
  reason: 'tracked',
  owner: 'team',
  approvedBy: 'owner',
  created: '2026-01-01T00:00:00.000Z',
  expires: EXPIRES,
};

class MemoryFs {
  private readonly files = new Map<string, string>();
  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
  async mkdir(_path: string): Promise<void> {}
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
}

interface Stop {
  engineRuns: number;
  stderr: string;
  stdout: string;
}

async function stopAt(fs: MemoryFs, now: string): Promise<Stop> {
  const deps = depsAt(now, [liveWaiver]);
  const stderr: string[] = [];
  const stdout: string[] = [];
  let engineRuns = 0;
  const exit = await runStopHookFromStdin(JSON.stringify({ session_id: 'session-waiver' }), {
    fs,
    pins: memoryPinStore(),
    cwd: () => '/repo/one',
    stdoutWrite: (text: string) => {
      stdout.push(text);
    },
    stderrWrite: (text: string) => {
      stderr.push(text);
    },
    readConfigBytes: async () => committedConfigBytes(JSON.stringify(config)),
    loadConfig: async () => config,
    buildDeps: async () => deps,
    runEngine: async (engineDeps: Deps, engineConfig: UsablConfig): Promise<Result> => {
      engineRuns += 1;
      return run(engineDeps, engineConfig);
    },
    evaluateDecision: evaluateStopDecision,
  });
  expect(exit).toBe(0);
  return { engineRuns, stderr: stderr.join(''), stdout: stdout.join('') };
}

// The fast path's first line on main. A full run never prints it.
const FAST_PATH = 'VERIFIED (exit 0, stored receipt, not re-scanned';

function blockOf(stop: Stop): { decision?: string; reason?: string } {
  return JSON.parse(stop.stdout.trim().split('\n')[0] ?? '{}') as { decision?: string; reason?: string };
}

describe('stop hook fast path and waiver expiry', () => {
  it('says verified from the stored receipt before the waiver ends and blocks on the barrier after', async () => {
    const fs = new MemoryFs();

    // First stop: no receipt yet, so the hook runs the engine, which waives the barrier and mints.
    const first = await stopAt(fs, MINTED);
    expect(first.engineRuns).toBe(1);
    const stored = JSON.parse((await fs.readFile('.usabl/receipt.json')) ?? 'null');
    expect(stored?.waiverExpiresAt).toBe(EXPIRES);

    // Before the waiver ends, the stored receipt answers and nothing is scanned.
    const before = await stopAt(fs, '2026-05-31T23:59:59.999Z');
    expect(before.engineRuns).toBe(0);
    expect(before.stderr.startsWith(FAST_PATH)).toBe(true);

    // Once the waiver ends, the receipt no longer stands, so the hook runs the full check, which
    // counts the accessibility barrier again and blocks the stop on it.
    const after = await stopAt(fs, EXPIRES);
    expect(after.engineRuns).toBe(1);
    expect(after.stderr).not.toContain(FAST_PATH);
    const block = blockOf(after);
    expect(block.decision).toBe('block');
    expect(block.reason).toContain('color-contrast');
  });

  it('runs the engine for a receipt from before the waiver end binding that counted waived findings', async () => {
    const fs = new MemoryFs();
    await stopAt(fs, MINTED);
    // A receipt written before waiverExpiresAt existed: no field, and two waived findings counted.
    const stored = JSON.parse((await fs.readFile('.usabl/receipt.json')) ?? 'null') as Record<string, unknown>;
    delete stored['waiverExpiresAt'];
    stored['activeWaivers'] = 2;
    await fs.writeFile('.usabl/receipt.json', JSON.stringify(stored));

    const next = await stopAt(fs, '2026-04-01T00:00:00.000Z');
    expect(next.engineRuns).toBe(1);
    expect(next.stderr).not.toContain(FAST_PATH);
  });
});
