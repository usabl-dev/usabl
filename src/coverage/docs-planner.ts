/**
 * Docs coverage planning maps a docs manifest to affected screens for the docs surface.
 * This is Phase A: scan every manifest page. A later phase narrows to pages affected by
 * changed docs source files and marks unmapped docs changes as not_covered.
 */
import type { AffectedScreen } from '../contracts/index.js';
import type { DocsManifest } from './docs-manifest.js';

function docsPageUrl(docsBaseUrl: string, pagePath: string): string {
  const base = new URL(docsBaseUrl);
  const joinBase = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  // Page paths start with '/'. Strip the leading slash so URL resolves relative to the
  // join base (not origin-absolute). This mirrors routeUrl in planner.ts.
  const normalizedPath = pagePath.startsWith('/') ? pagePath.slice(1) : pagePath;
  const joinBaseUrl = `${base.origin}${joinBase}`;
  const resolved = new URL(normalizedPath, joinBaseUrl);
  // The resolved URL must stay under the docs base path. This catches protocol-relative
  // URLs, .. traversal, and backslash traversal (WHATWG normalizes backslashes to slashes).
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(joinBase)) {
    throw new Error(`page url must stay under the docs base path: ${pagePath}`);
  }
  return resolved.toString();
}

export function computeDocsCoverage(manifest: DocsManifest | null): AffectedScreen[] {
  if (manifest === null) {
    return [];
  }
  return manifest.pages.map((page) => ({
    screenId: page.pageId,
    url: docsPageUrl(manifest.docsBaseUrl, page.url),
    provenance: 'docs-manifest' as const,
    profile: 'docs' as const,
  }));
}
