/**
 * Docs coverage planning maps changed docs files to affected screens for the docs surface.
 * Phase B: a changed .adoc source maps to only the pages whose sources array contains it.
 * A changed file matching sharedGlobs triggers a wide blast (every page affected). An
 * unmapped .adoc becomes an explicit coverage gap so the gate can return not_covered.
 */
import type { AffectedScreen, CoverageGap } from '../contracts/index.js';
import type { DocsManifest } from './docs-manifest.js';
import { GlobBudgetExhausted, GlobMatchBudget, globMatcher, RUN_GLOB_MATCH_STEPS } from '../primitives/match-glob.js';
import { configError } from '../intake/config-error.js';
import { globBudgetGapReason } from './glob-budget.js';

export function docsPageUrl(docsBaseUrl: string, pagePath: string): string {
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
    throw configError`page url must stay under the docs base path: ${pagePath}`;
  }
  return resolved.toString();
}

export interface DocsCoverage {
  affected: AffectedScreen[];
  unresolvedFiles: string[];
  gaps: CoverageGap[];
  nothingToCheck: boolean;
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

  // This planner carries its own glob matching budget, the same size as the app planner's. A
  // changed file usabl could not test against sharedGlobs before it ran out is a gap.
  const budget = new GlobMatchBudget(RUN_GLOB_MATCH_STEPS);
  const sharedMatchers = manifest.sharedGlobs.map((glob) => globMatcher(glob, { budget }));
  const sharedFiles = new Set<string>();
  const untestedFiles: string[] = [];
  const docFiles: string[] = [];
  for (const file of changedFiles) {
    try {
      const shared = sharedMatchers.some((matches) => matches(file));
      if (shared) sharedFiles.add(file);
      if (shared || file.endsWith('.adoc')) docFiles.push(file);
    } catch (err) {
      if (!(err instanceof GlobBudgetExhausted)) throw err;
      untestedFiles.push(file);
    }
  }
  const isWideBlastFile = (file: string): boolean => sharedFiles.has(file);
  if (docFiles.length === 0 && untestedFiles.length === 0) {
    return { affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true };
  }

  const affectedByScreen = new Map<string, AffectedScreen>();
  const unresolvedFiles: string[] = [...untestedFiles];
  const untestedReason = globBudgetGapReason('the sharedGlobs of usabl.docs.json');
  const gaps: CoverageGap[] = untestedFiles.map((file) => ({ ref: file, state: 'unresolved', reason: untestedReason }));

  const hasWideBlast = docFiles.some((file) => isWideBlastFile(file));
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
    const isWideBlastMatch = isWideBlastFile(file);
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
        reason:
          'changed docs file was not in any page sources or shared glob pattern. To fix it, add it to ' +
          'the sources of a page in usabl.docs.json, or to its sharedGlobs.',
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
