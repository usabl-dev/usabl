/**
 * Verifies that the demo app's repaired clusters screen and its settings screen
 * are a zero-finding oracle: the engine reports verified, mints a receipt, exits
 * 0, and leaves no coverage gap. The repaired dialog is selected with the app's
 * explicit `?variant=fixed` preview so this suite never edits the app's source.
 *
 * Run it with:
 *   USABL_FIXTURE_APP_CWD=/path/to/usabl-app npm run test:demo-integration
 *
 * It needs the demo app checkout and Playwright's Chromium. Without
 * USABL_FIXTURE_APP_CWD the suite skips. With a path that is not the demo app it
 * fails.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { buildDeps } from '../../src/deps/build.js';
import { run } from '../../src/run.js';
import {
  attachOutputBuffer,
  requestFixtureApp,
  startFixtureServer,
  stopFixtureServer,
  waitForServerReady,
  type FixtureServerProcess,
} from './fixture-app.js';

// Port 5173 is the demo's own dev server. A separate port keeps this suite runnable
// while the demo is up.
const FIXTURE_PORT = 5175;
const FIXTURE_BASE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
const FIXTURE_CHANGED_FILES = ['src/pages/Clusters.tsx', 'src/pages/Settings.tsx'];

const fixture = requestFixtureApp();

const fixtureConfig: UsablConfig = {
  appBaseUrl: FIXTURE_BASE_URL,
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: {
    routerFile: 'src/App.tsx',
    wideBlastGlobs: [],
  },
  surfaces: [
    {
      id: 'clusters',
      url: `${FIXTURE_BASE_URL}/clusters?variant=fixed`,
      files: ['src/pages/Clusters.tsx'],
    },
    {
      id: 'settings',
      url: `${FIXTURE_BASE_URL}/settings`,
      files: ['src/pages/Settings.tsx'],
    },
  ],
  guardedPaths: ['usabl.config.json'],
};

describe('fixture clean oracle integration', () => {
  if (fixture.kind === 'skip') {
    it('runs only against the live demo app', ({ skip }) => {
      skip(fixture.note);
    });
    return;
  }

  const appCwd = fixture.cwd;
  let fixtureServer: FixtureServerProcess | null = null;
  let fixtureOutput: string[] = [];

  beforeAll(async () => {
    fixtureServer = startFixtureServer(appCwd, FIXTURE_PORT);
    fixtureOutput = attachOutputBuffer(fixtureServer);
    await waitForServerReady(fixtureServer, fixtureOutput, `${FIXTURE_BASE_URL}/settings`);
  }, 60_000);

  afterAll(async () => {
    if (fixtureServer !== null) {
      await stopFixtureServer(fixtureServer);
    }
  }, 10_000);

  it(
    'treats the fixed fixture variant as a verified zero-finding oracle',
    async () => {
      const deps = await buildDeps(fixtureConfig, { cwd: appCwd });
      try {
        const result = await run(deps, fixtureConfig, { changedFiles: FIXTURE_CHANGED_FILES });
        const newFailures = result.findings.filter((finding) => finding.confidence === 'fail' && finding.status === 'new');

        expect(newFailures, `unexpected new failures: ${JSON.stringify(newFailures, null, 2)}`).toEqual([]);
        expect(result.verdict, `result was ${result.summary}`).toBe('verified');
        expect(result.receipt).not.toBeNull();
        expect(result.exitCode).toBe(0);
        expect(result.coverage.gaps).toEqual([]);
      } finally {
        await deps.browser.close();
      }
    },
    120_000,
  );
});
