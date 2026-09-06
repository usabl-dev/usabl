/**
 * Verifies the demo's hero flow against the live demo app.
 *
 * The demo app ships with a tracked source state in `src/demo/scenarios.ts`.
 * `npm run demo:break` and `npm run demo:repair` in that repo rewrite it. This
 * suite starts the app's dev server, uses the same switch script to put the source
 * in the broken state, runs the engine with the app's own usabl.config.json, and
 * expects a regression. It then repairs the source, runs again, and expects
 * verified with a receipt that re-verifies. The source file is restored to its
 * original bytes in `finally` and again in `afterAll`, so a failure cannot leave
 * the demo app dirty.
 *
 * Run it with:
 *   USABL_FIXTURE_APP_CWD=/path/to/usabl-app npm run test:demo-integration
 *
 * It needs the demo app checkout and Playwright's Chromium. Without
 * USABL_FIXTURE_APP_CWD the suite skips. With a path that is not the demo app it
 * fails.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Finding, Result } from '../../src/contracts/index.js';
import { buildDeps } from '../../src/deps/build.js';
import { verifyReceipt } from '../../src/evidence/receipt.js';
import { run } from '../../src/run.js';
import {
  attachOutputBuffer,
  loadFixtureConfig,
  requestFixtureApp,
  startFixtureServer,
  stopFixtureServer,
  waitForServerReady,
  type FixtureServerProcess,
} from './fixture-app.js';

const execFileAsync = promisify(execFile);
const FIXTURE_PORT = 5174;
const FIXTURE_BASE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
const SOURCE_STATE_FILE = 'src/demo/scenarios.ts';
const SOURCE_SWITCH_SCRIPT = 'scripts/set-demo-source.mjs';
// The demo pull request changes only the tracked source state. That single file is
// what the engine sees, and the app's config maps it to every surface.
const DEMO_CHANGED_FILES = [SOURCE_STATE_FILE];
const HERO_RULE = 'pf-modal-focus-return';

type SourceMode = 'broken' | 'repaired';

const fixture = requestFixtureApp();

function describeFindings(findings: Finding[]): string {
  return JSON.stringify(
    findings.map((finding) => ({
      rule: finding.rule,
      status: finding.status,
      confidence: finding.confidence,
      screenId: finding.screenId,
      elementPath: finding.elementPath,
    })),
    null,
    2,
  );
}

/** One line per phase so a run log shows what the engine found, not only that assertions held. */
function logPhase(phase: SourceMode, result: Result): void {
  const heroCount = result.findings.filter((finding) => finding.rule === HERO_RULE).length;
  const screens = result.screens.map((screen) => screen.screenId).join(', ');
  console.info(
    `[hero-bug flip] ${phase}: verdict=${result.verdict} exit=${result.exitCode} ` +
      `findings=${result.findings.length} ${HERO_RULE}=${heroCount} screens=[${screens}]`,
  );
}

function describeResult(result: Result): string {
  return JSON.stringify(
    {
      verdict: result.verdict,
      summary: result.summary,
      screens: result.screens.map((screen) => ({ id: screen.screenId, url: screen.url })),
      gaps: result.coverage.gaps,
      findings: JSON.parse(describeFindings(result.findings)),
    },
    null,
    2,
  );
}

describe('hero-bug flip integration', () => {
  if (fixture.kind === 'skip') {
    it('runs only against the live demo app', ({ skip }) => {
      skip(fixture.note);
    });
    return;
  }

  const appCwd = fixture.cwd;
  const sourceStatePath = join(appCwd, SOURCE_STATE_FILE);
  let originalSource: string | null = null;
  let fixtureServer: FixtureServerProcess | null = null;
  let fixtureOutput: string[] = [];

  async function setSourceMode(mode: SourceMode): Promise<void> {
    await execFileAsync('node', [SOURCE_SWITCH_SCRIPT, mode], { cwd: appCwd });
    await waitForServedSourceMode(mode);
  }

  /** The dev server transforms the module on demand; wait until it serves the new state. */
  async function waitForServedSourceMode(mode: SourceMode): Promise<void> {
    const pattern = new RegExp(`CURRENT_SOURCE_MODE\\s*=\\s*["']${mode}["']`);
    const deadline = Date.now() + 10_000;
    let lastBody = '';
    while (Date.now() < deadline) {
      const response = await fetch(`${FIXTURE_BASE_URL}/${SOURCE_STATE_FILE}`);
      lastBody = await response.text();
      if (response.ok && pattern.test(lastBody)) {
        return;
      }
      await delay(200);
    }
    throw new Error(`dev server never served ${SOURCE_STATE_FILE} in ${mode} mode; last body: ${lastBody.slice(0, 500)}`);
  }

  async function restoreSource(): Promise<void> {
    if (originalSource === null) {
      return;
    }
    await writeFile(sourceStatePath, originalSource, 'utf8');
    const restored = await readFile(sourceStatePath, 'utf8');
    if (restored !== originalSource) {
      throw new Error(`${SOURCE_STATE_FILE} was not restored to its original content`);
    }
  }

  beforeAll(async () => {
    await readFile(join(appCwd, SOURCE_SWITCH_SCRIPT), 'utf8').catch(() => {
      throw new Error(`${appCwd} has no ${SOURCE_SWITCH_SCRIPT}; the demo app source switch is required`);
    });
    originalSource = await readFile(sourceStatePath, 'utf8');
    fixtureServer = startFixtureServer(appCwd, FIXTURE_PORT);
    fixtureOutput = attachOutputBuffer(fixtureServer);
    await waitForServerReady(fixtureServer, fixtureOutput, `${FIXTURE_BASE_URL}/clusters`);
  }, 60_000);

  afterAll(async () => {
    try {
      await restoreSource();
    } finally {
      if (fixtureServer !== null) {
        await stopFixtureServer(fixtureServer);
      }
    }
  }, 15_000);

  it(
    'goes from regression on the broken source to verified on the repaired source',
    async () => {
      const config = loadFixtureConfig(appCwd, FIXTURE_BASE_URL);
      const deps = await buildDeps(config, { cwd: appCwd });
      try {
        await setSourceMode('broken');
        const broken = await run(deps, config, { changedFiles: DEMO_CHANGED_FILES });
        logPhase('broken', broken);
        expect(broken.verdict, `broken result was ${describeResult(broken)}`).toBe('regression');
        expect(broken.exitCode).toBe(1);
        expect(broken.receipt).toBeNull();

        const brokenHero = broken.findings.filter((finding) => finding.rule === HERO_RULE);
        expect(brokenHero, `broken findings were ${describeFindings(broken.findings)}`).not.toEqual([]);
        expect(brokenHero.every((finding) => finding.screenId === 'clusters')).toBe(true);
        expect(brokenHero.every((finding) => finding.status === 'new')).toBe(true);
        expect(brokenHero.every((finding) => finding.confidence === 'fail')).toBe(true);
        expect(broken.findings.some((finding) => finding.elementPath.includes('__usabl'))).toBe(false);

        await setSourceMode('repaired');
        // The repair is an uncommitted edit. The engine's own status reader must see it,
        // because that is how the editor hook and a local check discover the change.
        const uncommitted = (await deps.git.statusZ()).map((entry) => entry.path);
        expect(uncommitted).toContain(SOURCE_STATE_FILE);

        const repaired = await run(deps, config, { changedFiles: DEMO_CHANGED_FILES });
        logPhase('repaired', repaired);
        expect(repaired.verdict, `repaired result was ${describeResult(repaired)}`).toBe('verified');
        expect(repaired.exitCode).toBe(0);
        expect(repaired.coverage.gaps).toEqual([]);
        expect(repaired.findings.filter((finding) => finding.rule === HERO_RULE)).toEqual([]);
        expect(repaired.findings.some((finding) => finding.elementPath.includes('__usabl'))).toBe(false);
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
        try {
          await restoreSource();
        } finally {
          await deps.browser.close();
        }
      }
    },
    240_000,
  );
});
