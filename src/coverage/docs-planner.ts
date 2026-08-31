/**
 * Docs coverage planning maps changed docs files to affected screens for the docs surface.
 * Phase B: a changed .adoc source maps to only the pages whose sources array contains it.
 * A changed file matching sharedGlobs triggers a wide blast (every page affected). An
 * unmapped .adoc becomes an explicit coverage gap so the gate can return not_covered.
 */
import type { AffectedScreen, CoverageGap } from '../contracts/index.js';
import type { DocsManifest } from './docs-manifest.js';
import { matchGlob } from '../primitives/match-glob.js';

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

export interface DocsCoverage {
  affected: AffectedScreen[];
  unresolvedFiles: string[];
  gaps: CoverageGap[];
  nothingToCheck: boolean;
}

function isDocConcern(file: string, manifest: DocsManifest): boolean {
  return file.endsWith('.adoc') || manifest.sharedGlobs.some((glob) => matchGlob(glob, file));
}

function addAffected(target: Map<string, AffectedScreen>, candidate: AffectedScreen): void {
  if (!target.has(candidate.screenId)) {
    target.set(candidate.screenId, candidate);
  }
}

export function computeDocsCoverage(manifest: DocsManifest | null, changedFiles: string[]): DocsCoverage {
  if (manifest === null) {
    return { affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true };
  }

  const docFiles = changedFiles.filter((file) => isDocConcern(file, manifest));
  if (docFiles.length === 0) {
    return { affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true };
  }

  const affectedByScreen = new Map<string, AffectedScreen>();
  const unresolvedFiles: string[] = [];
  const gaps: CoverageGap[] = [];

  const hasWideBlast = docFiles.some((file) => manifest.sharedGlobs.some((glob) => matchGlob(glob, file)));
  if (hasWideBlast) {
    for (const page of manifest.pages) {
      addAffected(affectedByScreen, {
        screenId: page.pageId,
        url: docsPageUrl(manifest.docsBaseUrl, page.url),
        provenance: 'wide-blast',
        profile: 'docs',
      });
    }
  }

  for (const file of docFiles) {
    const isWideBlastMatch = manifest.sharedGlobs.some((glob) => matchGlob(glob, file));
    if (isWideBlastMatch) {
      continue;
    }

    let mapped = false;
    for (const page of manifest.pages) {
      if (!page.sources.includes(file)) {
        continue;
      }
      mapped = true;
      addAffected(affectedByScreen, {
        screenId: page.pageId,
        url: docsPageUrl(manifest.docsBaseUrl, page.url),
        provenance: 'docs-manifest',
        profile: 'docs',
      });
    }

    if (!mapped) {
      unresolvedFiles.push(file);
      gaps.push({
        ref: file,
        state: 'unresolved',
        reason: 'changed docs file was not in any page sources or shared glob pattern',
      });
    }
  }

  return {
    affected: [...affectedByScreen.values()],
    unresolvedFiles,
    gaps,
    nothingToCheck: false,
  };
}
