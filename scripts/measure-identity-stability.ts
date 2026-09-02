/**
 * Identity stability operator procedure:
 * 1) If the app needs a session, export one:
 *    npx playwright open --save-storage=/tmp/usabl-session.json "$IDENTITY_STABILITY_BASE_URL"
 *    Complete SSO and MFA, then visit each path you plan to measure.
 * 2) Set environment variables:
 *    export IDENTITY_STABILITY_BASE_URL='https://your-app-host.example'
 *    export IDENTITY_STABILITY_PATHS='/,/clusters,/settings'
 *    export IDENTITY_STABILITY_ROUNDS='3'
 *    export IDENTITY_STABILITY_STORAGE_STATE='/tmp/usabl-session.json'   # omit for a public app
 * 3) Run this script. Rounds take real time, so a session can expire mid-run. An expired session
 *    shows up as a gap on the later rounds (a redirect to login or an open failure), not as drift.
 *    Re-export the storage state and run again rather than reading those rounds as evidence.
 *
 * Why this exists: repeated scans of an unchanged page should produce the same element keys.
 * When they do not, the differential engine reads one barrier as both fixed and new and reports a
 * regression on a clean tree. This measures that drift. It decides nothing.
 */
import type {
  BrowserDriver,
  Capability,
  CoverageGap,
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

function gapReason(gaps: CoverageGap[]): string {
  return gaps.map((gap) => gap.reason).join('; ');
}

function observationOf(screenId: string, keys: string[], gap: string | null): ScreenObservation {
  return { screenId, keys, ...(gap === null ? {} : { gap }) };
}

async function observeScreen(
  browser: BrowserDriver,
  surface: Surface,
  config: UsablConfig,
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
    await page.armAnnouncementCapture();
    await page.focusBody();
    const { drafts, gaps } = await runProviders(
      providers,
      { page, screen: surface, config, profile: 'app' },
      capabilitiesFor(providers),
    );
    // A provider that could not run leaves an incomplete key set, so the round is disclosed as a
    // gap. Comparing a partial set against a full one would report drift the page did not cause.
    observation = observationOf(
      surface.id,
      identityKeysForDrafts(drafts),
      gaps.length === 0 ? null : gapReason(gaps),
    );
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
): Promise<StabilityRound> {
  const browser = makeRealBrowserDriver(
    storageStatePath === null ? {} : { storageStatePath },
  );
  const observations: StabilityRound = [];
  try {
    for (const surface of surfaces) {
      observations.push(await observeScreen(browser, surface, config));
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
    observed.push(await runRound(surfaces, config, storageStatePath));
  }

  const report = sanitizeReport(analyzeIdentityStability(observed));
  process.stdout.write(`${JSON.stringify({ runAt: new Date().toISOString(), ...report }, null, 2)}\n`);
  return 0;
}

main().then((exitCode) => process.exit(exitCode));
