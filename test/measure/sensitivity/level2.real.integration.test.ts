/**
 * Level 2 in real Chromium, on a small app served on loopback: the screens come from a config, the
 * scans go through buildDeps as `usabl check` builds them, and each mutation is made in the scan
 * browser only. A screen that cannot carry a defect is not applicable, never a pass and never a
 * miss. Gated behind USABL_INTEGRATION=1 because it launches Chromium.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../../src/contracts/index.js';
import { SENSITIVITY_CATALOG } from '../../../src/measure/sensitivity/catalog.js';
import { serveLevel1, type Level1Server } from '../../../src/measure/sensitivity/level1.js';
import { level2Screens, runLevel2 } from '../../../src/measure/sensitivity/level2.js';

const LEVEL2_BUDGET_MS = 900_000;

const ENTRIES = ['button-name-removed', 'control-out-of-tab-order', 'toast-not-live', 'flow-live-region-broken'];

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('Level 2 sensitivity in Chromium', { timeout: LEVEL2_BUDGET_MS }, () => {
  let app: Level1Server;
  let cwd: string;

  beforeAll(async () => {
    app = await serveLevel1();
    cwd = await mkdtemp(join(tmpdir(), 'usabl-sensitivity-app-'));
  });

  afterAll(async () => {
    await app.close();
    await rm(cwd, { recursive: true, force: true });
  });

  function config(): UsablConfig {
    return {
      appBaseUrl: app.baseUrl,
      uiFileGlobs: ['src/**'],
      discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
      surfaces: [
        { id: 'settings', url: `${app.baseUrl}/sensitivity-basic`, files: ['src/Settings.tsx'] },
        { id: 'clusters', url: `${app.baseUrl}/sensitivity-pf`, files: ['src/Clusters.tsx'] },
      ],
      guardedPaths: ['usabl.config.json'],
    };
  }

  it('measures the chosen entries on the configured screens, through the composition usabl check uses', async () => {
    const picked = level2Screens(config(), null);
    if (!picked.ok) throw new Error(picked.message);
    const measurements = await runLevel2({
      config: config(),
      cwd,
      screens: picked.screens,
      now: '2026-11-09T00:00:00.000Z',
      entries: SENSITIVITY_CATALOG.filter((entry) => ENTRIES.includes(entry.id)),
    });
    expect(measurements.map(({ entry, screen, outcome, rules }) => ({ entry, screen, outcome, rules }))).toEqual([
      { entry: 'button-name-removed', screen: 'settings', outcome: 'caught', rules: ['button-name', 'keyboard-walk-unnamed-interactive'] },
      {
        entry: 'button-name-removed',
        screen: 'clusters',
        outcome: 'caught',
        rules: ['button-name', 'keyboard-walk-unnamed-interactive', 'pf-icon-button-name'],
      },
      { entry: 'control-out-of-tab-order', screen: 'settings', outcome: 'missed', rules: [] },
      { entry: 'control-out-of-tab-order', screen: 'clusters', outcome: 'missed', rules: [] },
      { entry: 'toast-not-live', screen: 'settings', outcome: 'not applicable', rules: [] },
      { entry: 'toast-not-live', screen: 'clusters', outcome: 'caught', rules: ['pf-toast-live-region'] },
      { entry: 'flow-live-region-broken', screen: 'settings', outcome: 'not applicable', rules: [] },
      { entry: 'flow-live-region-broken', screen: 'clusters', outcome: 'not applicable', rules: [] },
    ]);
    expect(measurements.find((measurement) => measurement.entry === 'flow-live-region-broken')?.reason).toBe(
      'no approved flow requirement with an expected announcement names this screen',
    );
  });
});
