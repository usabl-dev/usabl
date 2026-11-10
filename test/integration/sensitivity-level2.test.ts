/**
 * Level 2 sensitivity on the live demo app: a few catalog entries run on its repaired settings
 * screen, which fixture-clean.test.ts pins as a zero-finding oracle, so the clean scan is readable
 * and only what a mutation adds can be new. Each mutation is made in the scan browser only; the
 * clone's source is never edited, and the real checkout must be clean before and after.
 *
 * It runs against a disposable clone of the demo app whose `usabl` package links to this engine
 * repository. Run it with:
 *   USABL_FIXTURE_APP_CWD=/path/to/usabl-app npm run test:demo-integration
 *
 * Without USABL_FIXTURE_APP_CWD the suite skips. With a path that is not the demo app it fails.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { SENSITIVITY_CATALOG } from '../../src/measure/sensitivity/catalog.js';
import { runLevel2 } from '../../src/measure/sensitivity/level2.js';
import {
  assertRealAppClean,
  budgetsFor,
  createDisposableApp,
  fixtureReadyTimeoutMs,
  requestFixtureApp,
  startFixtureServer,
  stopFixtureServer,
  type DisposableApp,
  type FixtureServer,
} from './fixture-app.js';

const ENTRIES = ['button-name-removed', 'control-out-of-tab-order', 'focus-trap'];
// Two loads per entry, each bounded by the app's readiness budget, plus a margin.
const LOADS = ENTRIES.length * 2;
const TIMEOUT_MARGIN_MS = 120_000;
const SETUP_GIT_CALLS = 5;

const fixture = requestFixtureApp();
const budgets = fixture.kind === 'run' ? budgetsFor(fixtureReadyTimeoutMs(fixture.cwd)) : null;
const testTimeoutMs = budgets === null ? 0 : LOADS * budgets.readyTimeoutMs + TIMEOUT_MARGIN_MS;
const setupTimeoutMs = budgets === null ? 0 : SETUP_GIT_CALLS * budgets.gitMs + budgets.serverStartMs + TIMEOUT_MARGIN_MS;
const teardownTimeoutMs = budgets === null ? 0 : budgets.gitMs + TIMEOUT_MARGIN_MS;

function demoConfig(baseUrl: string): UsablConfig {
  return {
    appBaseUrl: baseUrl,
    uiFileGlobs: ['src/**/*.tsx'],
    discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
    surfaces: [{ id: 'settings', url: `${baseUrl}/settings`, files: ['src/pages/Settings.tsx'] }],
    guardedPaths: ['usabl.config.json'],
  };
}

describe('Level 2 sensitivity on the demo app', () => {
  if (fixture.kind === 'skip') {
    it('runs only against the live demo app', ({ skip }) => {
      skip(fixture.note);
    });
    return;
  }

  const realAppCwd = fixture.cwd;
  let app: DisposableApp | null = null;
  let server: FixtureServer | null = null;

  beforeAll(async () => {
    app = await createDisposableApp(realAppCwd);
    server = await startFixtureServer(app, '/settings');
  }, setupTimeoutMs);

  afterAll(async () => {
    try {
      if (server !== null) {
        await stopFixtureServer(server);
      }
    } finally {
      if (app !== null) {
        await app.dispose();
      }
      await assertRealAppClean(realAppCwd, 'after the suite finished');
    }
  }, teardownTimeoutMs);

  it(
    'measures each entry on the settings screen without touching the source',
    async () => {
      if (app === null || server === null) {
        throw new Error('fixture app and server were not started');
      }
      const config = demoConfig(server.baseUrl);
      const measurements = await runLevel2({
        config,
        cwd: app.cwd,
        screens: [{ id: 'settings', url: config.surfaces[0]?.url ?? '' }],
        now: '2026-11-09T00:00:00.000Z',
        entries: SENSITIVITY_CATALOG.filter((entry) => ENTRIES.includes(entry.id)),
      });
      console.info(`[sensitivity level 2] ${JSON.stringify(measurements)}`);

      expect(measurements.map((measurement) => measurement.entry)).toEqual(ENTRIES);
      // The clean screen is an oracle, so no entry is unreadable for want of a clean scan.
      for (const measurement of measurements) {
        expect(measurement.outcome, JSON.stringify(measurement)).not.toBe('unreadable');
      }
      // No shipped rule reports a control taken out of the Tab order, on the demo app either.
      expect(measurements.find((measurement) => measurement.entry === 'control-out-of-tab-order')?.outcome).toBe('missed');
      expect(measurements.find((measurement) => measurement.entry === 'button-name-removed')?.outcome).toBe('caught');
      await assertRealAppClean(realAppCwd, 'after the mutations');
    },
    testTimeoutMs,
  );
});
