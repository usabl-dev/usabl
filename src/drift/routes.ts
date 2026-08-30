/**
 * Route drift detection compares the committed usabl.routes.json against the
 * app's current router file to identify added, removed, or matching routes.
 * Comparison is URL-only because discovered routes have no real entryFile or
 * operator-authored screenId.
 */
import type { RouteManifest } from '../coverage/route-manifest.js';

export interface RoutesDrift {
  added: string[];
  removed: string[];
  hasDrift: boolean;
}

export function computeRoutesDrift(
  configured: RouteManifest,
  discovered: RouteManifest,
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
      lines.push(`  ${url}`);
    }
  }

  if (drift.removed.length > 0) {
    lines.push(`\nRemoved routes (present in usabl.routes.json but missing from app router):`);
    for (const url of drift.removed) {
      lines.push(`  ${url}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
