/**
 * Fleet Insights operator procedure:
 * 1) Export a Playwright session:
 *    npx playwright open --save-storage=/tmp/fleet-insights-session.json "$FLEET_INSIGHTS_BASE_URL"
 * 2) Complete SSO and MFA, then visit /, /clusters, /workloads, and /settings.
 * 3) Set environment variables:
 *    export FLEET_INSIGHTS_BASE_URL='https://your-console-host.example'
 *    export FLEET_INSIGHTS_STORAGE_STATE='/tmp/fleet-insights-session.json'
 * 4) Run this script. Sessions expire, so re-export on 401 or 302.
 */
import type { CoverageGap, UsablConfig } from '../src/contracts/index.js';
import { buildDeps } from '../src/deps/build.js';
import { runMeasurementOnly, type MeasurementInput, type MeasurementReport } from '../src/measure/fleet-insights.js';
import { neutralize } from '../src/primitives/neutralize.js';
import { redactSecrets } from '../src/surfaces/scrub.js';

const NOTE = 'measurement-only: no verdict minted, no receipt written, nothing gated';

function sanitizeGapReason(reason: string): string {
  return neutralize(redactSecrets(reason));
}

function sanitizeGap(gap: CoverageGap): CoverageGap {
  return {
    ref: gap.ref,
    state: gap.state,
    reason: sanitizeGapReason(gap.reason),
  };
}

function sanitizeReport(report: MeasurementReport): MeasurementReport {
  return {
    ...report,
    note: NOTE,
    gaps: report.gaps.map((gap) => sanitizeGap(gap)),
  };
}

function ensureTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function buildFleetSurfaces(baseUrl: string): MeasurementInput[] {
  const normalizedBase = ensureTrailingSlash(baseUrl);
  return [
    { id: 'home', url: new URL('/', normalizedBase).toString() },
    { id: 'clusters', url: new URL('/clusters', normalizedBase).toString() },
    { id: 'workloads', url: new URL('/workloads', normalizedBase).toString() },
    { id: 'settings', url: new URL('/settings', normalizedBase).toString() },
  ];
}

function buildMeasurementConfig(baseUrl: string): UsablConfig {
  return {
    appBaseUrl: baseUrl,
    uiFileGlobs: ['src/**/*.tsx'],
    discovery: {
      routerFile: 'src/App.tsx',
      wideBlastGlobs: [],
    },
    surfaces: [],
    guardedPaths: ['usabl.config.json'],
  };
}

function requireEnv(name: 'FLEET_INSIGHTS_STORAGE_STATE' | 'FLEET_INSIGHTS_BASE_URL'): string | null {
  const value = process.env[name]?.trim();
  if (value !== undefined && value.length > 0) {
    return value;
  }

  if (name === 'FLEET_INSIGHTS_STORAGE_STATE') {
    process.stderr.write(
      'Set FLEET_INSIGHTS_STORAGE_STATE to a Playwright storageState JSON path before running measurement.\n',
    );
    process.stderr.write(
      'Example: export FLEET_INSIGHTS_STORAGE_STATE=/tmp/fleet-insights-session.json\n',
    );
    return null;
  }

  process.stderr.write('Set FLEET_INSIGHTS_BASE_URL to the Fleet Insights host before running measurement.\n');
  process.stderr.write("Example: export FLEET_INSIGHTS_BASE_URL='https://your-console-host.example'\n");
  return null;
}

async function main(): Promise<number> {
  const storageStatePath = requireEnv('FLEET_INSIGHTS_STORAGE_STATE');
  if (storageStatePath === null) {
    return 1;
  }
  const baseUrl = requireEnv('FLEET_INSIGHTS_BASE_URL');
  if (baseUrl === null) {
    return 1;
  }

  const config = buildMeasurementConfig(baseUrl);
  const surfaces = buildFleetSurfaces(baseUrl);
  const deps = await buildDeps(config, {
    cwd: process.cwd(),
    storageStatePath,
  });

  try {
    const report = await runMeasurementOnly(deps.checkRunner, surfaces);
    const safeReport = sanitizeReport(report);
    process.stdout.write(
      `${JSON.stringify({ runAt: new Date().toISOString(), ...safeReport }, null, 2)}\n`,
    );
    return 0;
  } finally {
    await deps.browser.close();
  }
}

main().then((exitCode) => process.exit(exitCode));
