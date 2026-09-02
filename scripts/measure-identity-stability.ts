/**
 * Identity stability operator procedure:
 * 1) If the app needs a session, export one:
 *    npx playwright open --save-storage=/tmp/usabl-session.json "$IDENTITY_STABILITY_BASE_URL"
 *    Complete SSO and MFA, then visit each path you plan to measure.
 * 2) Set environment variables:
 *    export IDENTITY_STABILITY_BASE_URL='https://your-app-host.example'
 *    export IDENTITY_STABILITY_PATHS='/,/clusters,/settings'
 *    export IDENTITY_STABILITY_ROUNDS='3'
 *    export IDENTITY_STABILITY_SETTLE_MS='10000'
 *    export IDENTITY_STABILITY_STORAGE_STATE='/tmp/usabl-session.json'   # omit for a public app
 * 3) Run this script. Rounds take real time, so a session can expire mid-run. An expired session
 *    shows up as a gap on the later rounds (a redirect to login or an open failure), not as drift.
 *    Re-export the storage state and run again rather than reading those rounds as evidence.
 *
 * Why this exists: repeated scans of an unchanged page should produce the same element keys.
 * When they do not, the differential engine reads one barrier as both fixed and new and reports a
 * regression on a clean tree. This measures that drift. It decides nothing.
 *
 * Why IDENTITY_STABILITY_SETTLE_MS exists: network idle does not mean rendered. A client-rendered
 * application mounts after the last response arrives, because the render is CPU work rather than
 * network work, so the providers can reach a document that holds only an empty mount point.
 * A page measured in that state yields almost no keys, every round yields the same almost nothing,
 * and the report reads as stable. That is a confidently wrong answer, which is worse than no answer.
 * The settle period is the wait between readiness and the providers. It costs one wait per screen
 * per round, so raise the value on a slow app and lower it on a server-rendered one.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type {
  BrowserDriver,
  Capability,
  Page,
  Provider,
  UsablConfig,
} from '../src/contracts/index.js';
import { makeRealBrowserDriver } from '../src/deps/real.js';
import {
  analyzeIdentityStability,
  identityKeysForDrafts,
  type IdentityStabilityReport,
  type ScreenObservation,
  type StabilityRound,
} from '../src/measure/identity-stability.js';
import { neutralize } from '../src/primitives/neutralize.js';
import { slug } from '../src/primitives/slug.js';
import { axeProvider } from '../src/providers/axe/index.js';
import { makeKeyboardWalkProvider } from '../src/providers/keyboard-walk/index.js';
import { runProviders } from '../src/providers/index.js';
import { makeRulepackProvider } from '../src/providers/rulepack/index.js';
import { redactSecrets } from '../src/surfaces/scrub.js';

const NOTE = 'measurement-only: no verdict minted, no receipt written, nothing gated';
const DEFAULT_ROUNDS = 3;
// Ten seconds is the wait that produced a complete key set on the real client-rendered application
// this harness was built against, where a shorter wait produced a near-empty one. The two mistakes
// are not equal: waiting too long only costs time, while waiting too little corrupts the answer and
// hides it behind a stable-looking report, so the default is the value that has been seen to work.
const DEFAULT_SETTLE_MS = 10_000;

// Deliberately broad. Counting an element that cannot really take focus only means the round is
// compared as usual, which is the safe direction. Missing one would disclose a gap on a page that
// did render, and that would hide a real result.
const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]';

interface Surface {
  id: string;
  url: string;
}

// Element keys and gap reasons both carry page-derived text, so nothing reaches the terminal raw.
function sanitize(text: string): string {
  return neutralize(redactSecrets(text));
}

function sanitizeReport(report: IdentityStabilityReport): IdentityStabilityReport {
  return {
    ...report,
    note: NOTE,
    screens: report.screens.map((screen) => ({
      ...screen,
      unstableKeys: screen.unstableKeys.map((key) => sanitize(key)),
      gaps: screen.gaps.map((gap) => sanitize(gap)),
    })),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ensureTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function buildSurfaces(baseUrl: string, paths: string[]): Surface[] {
  const normalizedBase = ensureTrailingSlash(baseUrl);
  return paths.map((path) => ({
    // The screen id is part of every identity key, so it must be derived from the path and stable.
    id: slug(path) || 'root',
    url: new URL(path, normalizedBase).toString(),
  }));
}

function buildMeasurementConfig(baseUrl: string): UsablConfig {
  // No repository is behind this run, so the config declares nothing. Today's providers read only
  // the profile, so an empty-but-valid config is honest rather than invented.
  return {
    appBaseUrl: baseUrl,
    uiFileGlobs: [],
    discovery: { routerFile: '', wideBlastGlobs: [] },
    surfaces: [],
    guardedPaths: [],
  };
}

// The same app-profile providers a live page check runs, in the same order. Interaction probes
// mutate focus, so the keyboard walk stays last.
function standardProviders(): Provider[] {
  return [axeProvider, makeRulepackProvider(), makeKeyboardWalkProvider()];
}

function capabilitiesFor(providers: Provider[]): Capability[] {
  return [...new Set(providers.flatMap((provider) => provider.capabilities))];
}

/**
 * A screen with nothing focusable on it is disclosed rather than compared.
 * The test is on the page and not on how many findings came back, because a finding count cannot
 * tell the two cases apart: an unmounted document still fails the page-level rules that need no
 * element, so it returns a handful of keys, returns the same handful every round, and reads as
 * stable. Zero focusable elements is not a threshold, it is the line between an application screen
 * being there and not being there, and every screen this harness measures runs the app profile,
 * which walks the keyboard and therefore assumes controls exist.
 * Disclosing a page that really did render costs the operator a stated reason they can act on.
 * Not disclosing one that did not costs them a wrong answer they have no way to see.
 */
function emptyPageReason(focusableCount: number): string | null {
  if (focusableCount > 0) {
    return null;
  }
  return 'the screen had no focusable elements, so there may have been no rendered page to measure; raise IDENTITY_STABILITY_SETTLE_MS if the page renders on the client';
}

function observationOf(screenId: string, keys: string[], gap: string | null): ScreenObservation {
  return { screenId, keys, ...(gap === null ? {} : { gap }) };
}

async function observeScreen(
  browser: BrowserDriver,
  surface: Surface,
  config: UsablConfig,
  settleMs: number,
): Promise<ScreenObservation> {
  let page: Page;
  try {
    page = await browser.open(surface.url);
  } catch (err) {
    return observationOf(surface.id, [], `screen failed to open: ${errorMessage(err)}`);
  }

  const providers = standardProviders();
  let observation = observationOf(surface.id, [], 'scan did not complete');
  try {
    await page.gotoReady();
    // Readiness means the network went quiet, and a client-rendered app mounts after that point.
    // Without this wait the providers can run against an empty mount point and measure a page that
    // does not exist yet, so the settle period comes before any of them touch the document.
    await delay(settleMs);
    // Counted before focusBody(), which puts a tabindex on the body and would count as an element.
    const focusable = await page.queryAll(FOCUSABLE_SELECTOR);
    await page.armAnnouncementCapture();
    await page.focusBody();
    const { drafts, gaps } = await runProviders(
      providers,
      { page, screen: surface, config, profile: 'app' },
      capabilitiesFor(providers),
    );
    // A provider that could not run leaves an incomplete key set, so the round is disclosed as a
    // gap. Comparing a partial set against a full one would report drift the page did not cause.
    const keys = identityKeysForDrafts(drafts);
    const reasons = gaps.map((gap) => gap.reason);
    const emptyPage = emptyPageReason(focusable.length);
    if (emptyPage !== null) {
      reasons.push(emptyPage);
    }
    observation = observationOf(surface.id, keys, reasons.length === 0 ? null : reasons.join('; '));
  } catch (err) {
    observation = observationOf(surface.id, [], `scan failed: ${errorMessage(err)}`);
  } finally {
    try {
      await page.close();
    } catch (err) {
      // Keep the keys this round already collected and disclose the cleanup failure with them,
      // so the round is reported as incomplete rather than silently dropped.
      observation = observationOf(
        surface.id,
        observation.keys,
        `scan cleanup failed: ${errorMessage(err)}`,
      );
    }
  }

  return observation;
}

/**
 * One round opens its own browser driver. A driver reused across rounds carries context and page
 * state, and that leaked state is itself a source of key drift, so each round starts clean.
 */
async function runRound(
  surfaces: Surface[],
  config: UsablConfig,
  storageStatePath: string | null,
  settleMs: number,
): Promise<StabilityRound> {
  const browser = makeRealBrowserDriver(
    storageStatePath === null ? {} : { storageStatePath },
  );
  const observations: StabilityRound = [];
  try {
    for (const surface of surfaces) {
      observations.push(await observeScreen(browser, surface, config, settleMs));
    }
  } finally {
    await browser.close();
  }
  return observations;
}

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function readPaths(): string[] {
  const raw = readEnv('IDENTITY_STABILITY_PATHS');
  if (raw === null) {
    return ['/'];
  }
  return raw
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}

function readRounds(): number | null {
  const raw = readEnv('IDENTITY_STABILITY_ROUNDS');
  if (raw === null) {
    return DEFAULT_ROUNDS;
  }
  const rounds = Number(raw);
  if (!Number.isInteger(rounds) || rounds < 1) {
    process.stderr.write('IDENTITY_STABILITY_ROUNDS must be a whole number of 1 or more.\n');
    return null;
  }
  return rounds;
}

function readSettleMs(): number | null {
  const raw = readEnv('IDENTITY_STABILITY_SETTLE_MS');
  if (raw === null) {
    return DEFAULT_SETTLE_MS;
  }
  const settleMs = Number(raw);
  if (!Number.isInteger(settleMs) || settleMs < 0) {
    process.stderr.write(
      'IDENTITY_STABILITY_SETTLE_MS must be a whole number of milliseconds, 0 or more. Example: 10000\n',
    );
    return null;
  }
  return settleMs;
}

async function main(): Promise<number> {
  const baseUrl = readEnv('IDENTITY_STABILITY_BASE_URL');
  if (baseUrl === null) {
    process.stderr.write('Set IDENTITY_STABILITY_BASE_URL to the app host before running measurement.\n');
    process.stderr.write("Example: export IDENTITY_STABILITY_BASE_URL='https://your-app-host.example'\n");
    return 1;
  }

  const rounds = readRounds();
  if (rounds === null) {
    return 1;
  }

  const settleMs = readSettleMs();
  if (settleMs === null) {
    return 1;
  }

  const paths = readPaths();
  if (paths.length === 0) {
    process.stderr.write('IDENTITY_STABILITY_PATHS was set but held no paths. Example: /,/clusters,/settings\n');
    return 1;
  }

  const storageStatePath = readEnv('IDENTITY_STABILITY_STORAGE_STATE');
  if (storageStatePath === null) {
    process.stderr.write(
      'No IDENTITY_STABILITY_STORAGE_STATE set. Measuring signed out; a login redirect will read as a gap.\n',
    );
  }

  const config = buildMeasurementConfig(baseUrl);
  const surfaces = buildSurfaces(baseUrl, paths);
  const observed: StabilityRound[] = [];
  for (let round = 0; round < rounds; round += 1) {
    observed.push(await runRound(surfaces, config, storageStatePath, settleMs));
  }

  const report = sanitizeReport(analyzeIdentityStability(observed));
  process.stdout.write(`${JSON.stringify({ runAt: new Date().toISOString(), ...report }, null, 2)}\n`);
  return 0;
}

main().then((exitCode) => process.exit(exitCode));
