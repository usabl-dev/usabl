/**
 * Verifies the demo's hero flow against a disposable clone of the live demo app.
 *
 * The demo app ships with a tracked source state in `src/demo/scenarios.ts`.
 * `npm run demo:break` and `npm run demo:repair` in that repo rewrite it. This
 * suite clones the app at HEAD into a temp dir, wires the clone's `usabl` package
 * to this engine repository, starts the clone's dev server, and uses the app's
 * own switch script to put the source in the broken state. It runs the engine
 * with the app's own usabl.config.json and expects a regression with a fixed set
 * of findings. It then repairs the source, runs again, and expects verified with
 * a receipt that re-verifies. Both phases assert the exact affected and scanned
 * screen sets, no coverage gaps, and that the scanned pages carried no overlay.
 *
 * The real checkout is never written to. It must have a clean `git status`
 * before and after, and the clone is removed in `afterAll`. If the runner is
 * killed, the clone and its Vite process stay until the next run removes them.
 *
 * Run it with:
 *   USABL_FIXTURE_APP_CWD=/path/to/usabl-app npm run test:demo-integration
 *
 * It needs the demo app checkout, Playwright's Chromium, and a built engine
 * (`dist/`; the npm script builds first). Without USABL_FIXTURE_APP_CWD the suite
 * skips. With a path that is not the demo app it fails.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Deps, Result } from '../../src/contracts/index.js';
import { buildDeps } from '../../src/deps/build.js';
import { verifyReceipt } from '../../src/evidence/receipt.js';
import { run } from '../../src/run.js';
import {
  assertRealAppClean,
  budgetsFor,
  createDisposableApp,
  fetchText,
  fixtureReadyTimeoutMs,
  loadFixtureConfig,
  normalizeFindings,
  requestFixtureApp,
  startFixtureServer,
  stopFixtureServer,
  switchDemoSource,
  type DisposableApp,
  type FixtureServer,
} from './fixture-app.js';

const SOURCE_STATE_FILE = 'src/demo/scenarios.ts';
const SOURCE_SWITCH_SCRIPT = 'scripts/set-demo-source.mjs';
// The demo pull request changes only the tracked source state. That single file is
// what the engine sees, and the route graph maps it to the screens that import it.
const DEMO_CHANGED_FILES = [SOURCE_STATE_FILE];
const HERO_RULE = 'pf-modal-focus-return';
const OVERLAY_HOST_SELECTOR = '#__usabl-overlay';

// Oracle for the demo app at its current commit. Sorted screen ids the change must
// reach, and the sorted `screen:rule` pairs the broken source must produce. A drop or
// a shift here is a real change in the engine or the demo, so it fails the test and
// the message prints both lists.
const EXPECTED_SCREENS = ['clusters', 'deployments'];
const BROKEN_ORACLE: string[] = [
  'clusters:pf-focus-into-dialog',
  'clusters:pf-modal-focus-return',
  'deployments:button-name',
  'deployments:keyboard-walk-unnamed-interactive',
  'deployments:pf-icon-button-name',
  'deployments:pf-kebab-expanded-state',
  'deployments:pf-row-action-name-unique',
  'deployments:pf-toolbar-labeled-when-repeated',
  'deployments:pf-toolbar-labeled-when-repeated',
];
const REPAIRED_ORACLE: string[] = [];

// Page opens per run: one scan per expected screen, then one overlay check per screen.
const PAGE_OPENS_PER_PHASE = EXPECTED_SCREENS.length * 2;
const PHASES = 2;
// Git work, receipt verification, and provider time on top of the per-operation budgets.
const TIMEOUT_MARGIN_MS = 90_000;
// Git calls in beforeAll: status, rev-parse, clone, checkout, rev-parse.
const SETUP_GIT_CALLS = 5;

type SourceMode = 'broken' | 'repaired';

const fixture = requestFixtureApp();
const budgets = fixture.kind === 'run' ? budgetsFor(fixtureReadyTimeoutMs(fixture.cwd)) : null;
// Every wait in the test has a budget; the test timeout is their sum plus a margin.
const testTimeoutMs =
  budgets === null
    ? 0
    : PAGE_OPENS_PER_PHASE * PHASES * budgets.readyTimeoutMs + PHASES * budgets.sourceSwitchMs + TIMEOUT_MARGIN_MS;
const setupTimeoutMs = budgets === null ? 0 : SETUP_GIT_CALLS * budgets.gitMs + budgets.serverStartMs + TIMEOUT_MARGIN_MS;
const teardownTimeoutMs = budgets === null ? 0 : budgets.gitMs + TIMEOUT_MARGIN_MS;

function screenIds(result: Result): { affected: string[]; scanned: string[] } {
  return {
    affected: result.coverage.affected.map((screen) => screen.screenId).sort(),
    scanned: result.screens.map((screen) => screen.screenId).sort(),
  };
}

function describeResult(result: Result): string {
  return JSON.stringify(
    {
      verdict: result.verdict,
      summary: result.summary,
      ...screenIds(result),
      gaps: result.coverage.gaps,
      findings: normalizeFindings(result.findings),
    },
    null,
    2,
  );
}

/** One line per phase so a run log shows what the engine found, not only that assertions held. */
function logPhase(phase: SourceMode, result: Result): void {
  const heroCount = result.findings.filter((finding) => finding.rule === HERO_RULE).length;
  console.info(
    `[hero-bug flip] ${phase}: verdict=${result.verdict} exit=${result.exitCode} ` +
      `findings=${result.findings.length} ${HERO_RULE}=${heroCount} screens=[${screenIds(result).scanned.join(', ')}]`,
  );
}

function expectCoverage(phase: SourceMode, result: Result): void {
  const ids = screenIds(result);
  expect(ids.affected, `${phase} affected screens; result was ${describeResult(result)}`).toEqual(EXPECTED_SCREENS);
  expect(ids.scanned, `${phase} scanned screens; result was ${describeResult(result)}`).toEqual(EXPECTED_SCREENS);
  expect(result.coverage.gaps, `${phase} coverage gaps`).toEqual([]);
}

/**
 * The engine's browser is a webdriver session, and the overlay loader must not mount
 * for it. Open every scanned URL through the engine's own driver and assert the DOM
 * holds no overlay host. Finding paths are checked separately.
 */
async function expectNoOverlayOnScannedPages(phase: SourceMode, deps: Deps, result: Result): Promise<void> {
  for (const screen of result.screens) {
    const page = await deps.browser.open(screen.url);
    try {
      await page.gotoReady();
      const hosts = await page.queryAll(OVERLAY_HOST_SELECTOR);
      expect(hosts, `${phase} ${screen.screenId} at ${screen.url} rendered an overlay host`).toEqual([]);
    } finally {
      await page.close();
    }
  }
  expect(
    result.findings.filter((finding) => finding.elementPath.includes('__usabl')),
    `${phase} findings that point into the usabl overlay`,
  ).toEqual([]);
}

describe('hero-bug flip integration', () => {
  if (fixture.kind === 'skip') {
    it('runs only against the live demo app', ({ skip }) => {
      skip(fixture.note);
    });
    return;
  }

  const realAppCwd = fixture.cwd;
  let app: DisposableApp | null = null;
  let server: FixtureServer | null = null;

  function requireApp(): { app: DisposableApp; server: FixtureServer } {
    if (app === null || server === null) {
      throw new Error('fixture app and server were not started');
    }
    return { app, server };
  }

  async function setSourceMode(mode: SourceMode): Promise<void> {
    const { app: current } = requireApp();
    await switchDemoSource(current, SOURCE_SWITCH_SCRIPT, mode);
    await waitForServedSourceMode(mode);
  }

  /** The dev server transforms the module on demand; wait until it serves the new state. */
  async function waitForServedSourceMode(mode: SourceMode): Promise<void> {
    const { app: current, server: currentServer } = requireApp();
    const pattern = new RegExp(`CURRENT_SOURCE_MODE\\s*=\\s*["']${mode}["']`);
    const budgetMs = current.budgets.sourceSwitchMs;
    const deadline = Date.now() + budgetMs;
    let lastReason = 'request never succeeded';
    while (Date.now() < deadline) {
      try {
        const response = await fetchText(`${currentServer.baseUrl}/${SOURCE_STATE_FILE}`);
        if (response.ok && pattern.test(response.body)) {
          return;
        }
        lastReason = response.ok ? `body did not show ${mode}: ${response.body.slice(0, 200)}` : `HTTP ${response.status}`;
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
      }
      await delay(200);
    }
    throw new Error(`dev server did not serve ${SOURCE_STATE_FILE} in ${mode} mode within ${budgetMs}ms: ${lastReason}`);
  }

  beforeAll(async () => {
    app = await createDisposableApp(realAppCwd);
    await readFile(join(app.cwd, SOURCE_SWITCH_SCRIPT), 'utf8').catch(() => {
      throw new Error(`${realAppCwd} has no ${SOURCE_SWITCH_SCRIPT}; the demo app source switch is required`);
    });
    console.info(`[hero-bug flip] clone ${app.cwd} at ${app.head}; node_modules/usabl -> ${app.enginePath}`);
    server = await startFixtureServer(app, '/clusters');
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
    'goes from regression on the broken source to verified on the repaired source',
    async () => {
      const { app: current, server: currentServer } = requireApp();
      const config = loadFixtureConfig(current.cwd, currentServer.baseUrl);
      const deps = await buildDeps(config, { cwd: current.cwd });
      try {
        await setSourceMode('broken');
        const broken = await run(deps, config, { changedFiles: DEMO_CHANGED_FILES });
        logPhase('broken', broken);
        expect(broken.verdict, `broken result was ${describeResult(broken)}`).toBe('regression');
        expect(broken.exitCode).toBe(1);
        expect(broken.receipt).toBeNull();
        expectCoverage('broken', broken);
        expect(
          normalizeFindings(broken.findings),
          `broken findings changed; expected ${JSON.stringify(BROKEN_ORACLE)}`,
        ).toEqual(BROKEN_ORACLE);

        const brokenHero = broken.findings.filter((finding) => finding.rule === HERO_RULE);
        expect(brokenHero.map((finding) => finding.screenId)).toEqual(['clusters']);
        expect(brokenHero.every((finding) => finding.status === 'new')).toBe(true);
        expect(brokenHero.every((finding) => finding.confidence === 'fail')).toBe(true);
        await expectNoOverlayOnScannedPages('broken', deps, broken);

        await setSourceMode('repaired');
        // The repair is an uncommitted edit. The engine's own status reader must see it,
        // because that is how the editor hook and a local check discover the change.
        const uncommitted = (await deps.git.statusZ()).map((entry) => entry.path);
        expect(uncommitted).toContain(SOURCE_STATE_FILE);

        const repaired = await run(deps, config, { changedFiles: DEMO_CHANGED_FILES });
        logPhase('repaired', repaired);
        expect(repaired.verdict, `repaired result was ${describeResult(repaired)}`).toBe('verified');
        expect(repaired.exitCode).toBe(0);
        expectCoverage('repaired', repaired);
        expect(
          normalizeFindings(repaired.findings),
          `repaired findings changed; expected ${JSON.stringify(REPAIRED_ORACLE)}`,
        ).toEqual(REPAIRED_ORACLE);
        await expectNoOverlayOnScannedPages('repaired', deps, repaired);
        expect(repaired.receipt).not.toBeNull();
        if (repaired.receipt === null) {
          throw new Error('expected receipt for verified result');
        }

        const currentTree = await deps.git.writeTree();
        await expect(verifyReceipt(deps, config, repaired.receipt, currentTree)).resolves.toEqual({
          valid: true,
          failedFields: [],
        });
      } finally {
        await deps.browser.close();
      }
    },
    testTimeoutMs,
  );
});
