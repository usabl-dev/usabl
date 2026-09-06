/**
 * Verifies that the demo app's repaired clusters screen and its settings screen
 * are a zero-finding oracle: the engine reports verified, mints a receipt, exits
 * 0, scans exactly those two screens, and leaves no coverage gap. The repaired
 * dialog is selected with the app's explicit `?variant=fixed` preview so this
 * suite never edits source.
 *
 * It runs against a disposable clone of the demo app whose `usabl` package links
 * to this engine repository. The real checkout is never written to and must have
 * a clean `git status` before and after.
 *
 * Run it with:
 *   USABL_FIXTURE_APP_CWD=/path/to/usabl-app npm run test:demo-integration
 *
 * It needs the demo app checkout, Playwright's Chromium, and a built engine
 * (`dist/`; the npm script builds first). Without USABL_FIXTURE_APP_CWD the suite
 * skips. With a path that is not the demo app it fails.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { buildDeps } from '../../src/deps/build.js';
import { run } from '../../src/run.js';
import {
  assertRealAppClean,
  createDisposableApp,
  fixtureReadyTimeoutMs,
  normalizeFindings,
  requestFixtureApp,
  startFixtureServer,
  stopFixtureServer,
  type DisposableApp,
  type FixtureServer,
} from './fixture-app.js';

const FIXTURE_CHANGED_FILES = ['src/pages/Clusters.tsx', 'src/pages/Settings.tsx'];
const EXPECTED_SCREENS = ['clusters', 'settings'];
const TIMEOUT_MARGIN_MS = 60_000;

const fixture = requestFixtureApp();
const testTimeoutMs =
  fixture.kind === 'run' ? EXPECTED_SCREENS.length * fixtureReadyTimeoutMs(fixture.cwd) + TIMEOUT_MARGIN_MS : 0;

function fixtureConfig(baseUrl: string): UsablConfig {
  return {
    appBaseUrl: baseUrl,
    uiFileGlobs: ['src/**/*.tsx'],
    discovery: {
      routerFile: 'src/App.tsx',
      wideBlastGlobs: [],
    },
    surfaces: [
      {
        id: 'clusters',
        url: `${baseUrl}/clusters?variant=fixed`,
        files: ['src/pages/Clusters.tsx'],
      },
      {
        id: 'settings',
        url: `${baseUrl}/settings`,
        files: ['src/pages/Settings.tsx'],
      },
    ],
    guardedPaths: ['usabl.config.json'],
  };
}

describe('fixture clean oracle integration', () => {
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
    console.info(`[fixture clean] clone ${app.cwd} at ${app.head}; node_modules/usabl -> ${app.enginePath}`);
    server = await startFixtureServer(app, '/settings');
  }, 90_000);

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
  }, 30_000);

  it(
    'treats the fixed fixture variant as a verified zero-finding oracle',
    async () => {
      if (app === null || server === null) {
        throw new Error('fixture app and server were not started');
      }
      const config = fixtureConfig(server.baseUrl);
      const deps = await buildDeps(config, { cwd: app.cwd });
      try {
        const result = await run(deps, config, { changedFiles: FIXTURE_CHANGED_FILES });
        const findings = normalizeFindings(result.findings);
        console.info(
          `[fixture clean] verdict=${result.verdict} exit=${result.exitCode} findings=${findings.length} ` +
            `screens=[${result.screens.map((screen) => screen.screenId).sort().join(', ')}]`,
        );

        expect(findings, `findings were ${JSON.stringify(result.findings, null, 2)}`).toEqual([]);
        expect(result.verdict, `result was ${result.summary}`).toBe('verified');
        expect(result.receipt).not.toBeNull();
        expect(result.exitCode).toBe(0);
        expect(result.coverage.affected.map((screen) => screen.screenId).sort()).toEqual(EXPECTED_SCREENS);
        expect(result.screens.map((screen) => screen.screenId).sort()).toEqual(EXPECTED_SCREENS);
        expect(result.coverage.gaps).toEqual([]);
      } finally {
        await deps.browser.close();
      }
    },
    testTimeoutMs,
  );
});
