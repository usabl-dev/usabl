/**
 * Route drift detection compares the committed usabl.routes.json against the
 * app's current router file to identify added, removed, or matching routes.
 * Comparison is URL-only because discovered routes have no real entryFile or
 * operator-authored screenId.
 */
import type { FsGlob } from '../contracts/index.js';
import { parseConfiguredManifest, parseDiscoveredManifest } from '../coverage/route-manifest.js';
import type { RouteManifest } from '../coverage/route-manifest.js';
import { neutralize } from '../primitives/neutralize.js';

export interface RoutesDrift {
  added: string[];
  removed: string[];
  hasDrift: boolean;
}

export interface RoutesDriftOutcome {
  exitCode: 0 | 1 | 2;
  stdout?: string;
  stderr?: string;
}

// Drift compares route urls only and never reads manifest provenance, so it asks for the routes
// alone. That keeps every caller, including tests, free of a field this comparison does not use.
export function computeRoutesDrift(
  configured: Pick<RouteManifest, 'routes'>,
  discovered: Pick<RouteManifest, 'routes'>,
): RoutesDrift {
  const configuredUrls = new Set(configured.routes.map((r) => r.url));
  const discoveredUrls = new Set(discovered.routes.map((r) => r.url));

  const added: string[] = [];
  for (const url of discoveredUrls) {
    if (!configuredUrls.has(url)) {
      added.push(url);
    }
  }

  const removed: string[] = [];
  for (const url of configuredUrls) {
    if (!discoveredUrls.has(url)) {
      removed.push(url);
    }
  }

  added.sort();
  removed.sort();

  return {
    added,
    removed,
    hasDrift: added.length > 0 || removed.length > 0,
  };
}

export function formatDriftReport(drift: RoutesDrift): string {
  if (!drift.hasDrift) {
    return 'No drift detected. Configured routes match discovered routes.\n';
  }

  const lines: string[] = ['Route drift detected:\n'];

  if (drift.added.length > 0) {
    lines.push(`\nAdded routes (present in app router but missing from usabl.routes.json):`);
    for (const url of drift.added) {
      lines.push(`  ${neutralize(url)}`);
    }
    lines.push(
      `\nNote: object properties named "path" that are not routes (for example an HTTP client or build config sharing the key) can appear as false additions. Verify before acting.`,
    );
  }

  if (drift.removed.length > 0) {
    lines.push(`\nRemoved routes (present in usabl.routes.json but missing from app router):`);
    for (const url of drift.removed) {
      lines.push(`  ${neutralize(url)}`);
    }
    lines.push(
      `\nNote: routes written in styles usabl cannot parse (for example computed paths or variable paths) can appear as false removals. Verify before acting.`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

export async function runRoutesDrift(fs: FsGlob, routerFile: string): Promise<RoutesDriftOutcome> {
  // Note: an empty sidecar plus an app whose routes are all unparseable produces
  // empty-versus-empty and reports exit 0 no drift, which is a known limitation
  // of URL-only discovery.
  const configured = await parseConfiguredManifest(fs);
  if (configured === null) {
    return {
      exitCode: 2,
      stderr: 'usabl: usabl.routes.json not found. Run "usabl init" to create the sidecar.\n',
    };
  }

  const discovered = await parseDiscoveredManifest(fs, routerFile);
  if (discovered === null) {
    return {
      exitCode: 2,
      stderr: `usabl: router file ${neutralize(routerFile)} not found or unreadable. Cannot discover routes.\n`,
    };
  }

  if (discovered.routes.length === 0 && configured.routes.length > 0) {
    return {
      exitCode: 2,
      stderr: `usabl: discovered no routes in ${neutralize(routerFile)}. This usually means the router uses a style usabl cannot parse (for example computed paths or variable paths). Verify the router file and usabl.routes.json manually; usabl will not report drift it cannot confirm.\n`,
    };
  }

  const drift = computeRoutesDrift(configured, discovered);
  return {
    exitCode: drift.hasDrift ? 1 : 0,
    stdout: formatDriftReport(drift),
  };
}
