/**
 * Docs coverage planning maps a docs manifest to affected screens for the docs surface.
 * This is Phase A: scan every manifest page. A later phase narrows to pages affected by
 * changed docs source files and marks unmapped docs changes as not_covered.
 */
import type { AffectedScreen } from '../contracts/index.js';
import type { DocsManifest } from './docs-manifest.js';

function docsPageUrl(docsBaseUrl: string, pagePath: string): string {
  const base = new URL(docsBaseUrl);
  const expectedOrigin = base.origin;
  // Protocol-relative URLs (//evil.com/x) are rejected before they reach URL construction.
  if (pagePath.startsWith('//')) {
    throw new Error(`page url must stay on docs origin: ${pagePath}`);
  }
  // pagePath starts with '/', and URL constructor treats absolute paths as origin-relative.
  // To join relative to the base path, strip the leading slash and use base.pathname.
  const normalizedPath = pagePath.startsWith('/') ? pagePath.slice(1) : pagePath;
  const joinBase = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const resolved = new URL(`${base.origin}${joinBase}${normalizedPath}`);
  // Page urls must remain on the declared docs origin. A manifest entry that changes
  // origin would mint dishonest scan targets outside declared scope.
  if (resolved.origin !== expectedOrigin) {
    throw new Error(`page url must stay on docs origin: ${pagePath}`);
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
