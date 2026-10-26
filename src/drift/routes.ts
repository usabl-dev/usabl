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
      `\nNote: usabl reads every route the router declares, including one behind a condition or one only some users reach, so a route the app never serves to you can appear as a false addition. Verify before acting.`,
    );
  }

  if (drift.removed.length > 0) {
    lines.push(`\nRemoved routes (present in usabl.routes.json but missing from app router):`);
    for (const url of drift.removed) {
      lines.push(`  ${neutralize(url)}`);
    }
    lines.push(
      `\nNote: a route whose path usabl cannot read (for example a computed path or a path imported from another module) can appear as a false removal. usabl names each such route when it finds one. Verify before acting.`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

export async function runRoutesDrift(fs: FsGlob, routerFile: string): Promise<RoutesDriftOutcome> {
  // Note: an empty sidecar plus a router file that declares no router at all produces
  // empty-versus-empty and reports exit 0 no drift, which is a known limitation
  // of URL-only discovery. A route usabl found but could not read refuses below instead.
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

  // A route usabl could not read, or a router file that does not parse, leaves the discovered list
  // incomplete, so neither "no drift" nor a removal can be confirmed. Each one is named with its
  // file and line, and the run refuses with exit 2 after printing the comparison it could make.
  const unreadable = discovered.unreadable ?? [];
  const unreadableLines = unreadable.map(
    (gap) => `  ${neutralize(gap.file)}${gap.line === null || gap.wholeFile === true ? '' : ` line ${gap.line}`}: ${gap.reason}`,
  );

  if (discovered.routes.length === 0 && configured.routes.length > 0) {
    return {
      exitCode: 2,
      stderr:
        `usabl: discovered no routes in ${neutralize(routerFile)}. usabl reads routes from a <Routes> element or a create*Router call in this file, so routes built by code or kept in another file are not found. Verify the router file and usabl.routes.json manually; usabl will not report drift it cannot confirm.\n` +
        (unreadableLines.length > 0 ? `${unreadableLines.join('\n')}\n` : ''),
    };
  }

  const drift = computeRoutesDrift(configured, discovered);
  if (unreadableLines.length > 0) {
    return {
      exitCode: 2,
      stdout: formatDriftReport(drift),
      stderr:
        `usabl: could not read ${unreadable.length} route declaration(s) in ${neutralize(routerFile)}, so this drift report may be incomplete:\n` +
        `${unreadableLines.join('\n')}\n` +
        'Verify these routes against usabl.routes.json by hand; usabl will not report drift it cannot confirm.\n',
    };
  }
  return {
    exitCode: drift.hasDrift ? 1 : 0,
    stdout: formatDriftReport(drift),
  };
}
