/**
 * Formats import-graph unresolvable entries into human-readable discovery detail.
 * Used when a changed file lands in unresolvedFiles so the gap reason names a fix path.
 */
import type { UnresolvableImport } from './import-graph.js';

const MAX_DETAIL_LINES = 3;

export function formatUnresolvableImport(entry: UnresolvableImport): string {
  if (entry.kind === 'alias-unconfigured') {
    return `could not resolve '${entry.specifier}' in ${entry.importer}: no alias mapping found in tsconfig or vite config`;
  }
  if (entry.kind === 'alias-unmapped') {
    return `could not resolve '${entry.specifier}' in ${entry.importer}: no alias mapping matches this prefix in tsconfig or vite config`;
  }
  if (entry.kind === 'ambiguous-candidates') {
    return `could not resolve '${entry.specifier}' in ${entry.importer}: more than one file matches (${entry.candidates.join(', ')}), and usabl does not know which one the bundler loads, so it follows all of them. Write the import with the file's extension`;
  }
  return `could not resolve '${entry.specifier}' in ${entry.importer}: resolved path has no matching file on disk`;
}

export function selectDiscoveryDetails(
  file: string,
  unresolvable: UnresolvableImport[],
  visitedFiles: ReadonlySet<string>,
): string[] {
  const relevant = unresolvable.filter(
    (entry) => entry.importer === file || visitedFiles.has(entry.importer),
  );
  const lines = relevant.map(formatUnresolvableImport);
  if (lines.length <= MAX_DETAIL_LINES) {
    return lines;
  }
  const shown = lines.slice(0, MAX_DETAIL_LINES);
  const remaining = lines.length - MAX_DETAIL_LINES;
  return [...shown, `(${remaining} more import resolution issue(s) not shown)`];
}

// The two ways an operator places a file on a screen. Printed after the reason, so a person who
// meets an unplaced file, often a shared layout that every route imports in a way usabl cannot
// follow, learns what to change without reading the docs.
export const UNPLACED_FILE_FIX =
  'To fix it, add it to the files of a surface in usabl.config.json, or add the route that renders it ' +
  'to usabl.routes.json with an entryFile that imports it.';

export function buildUnresolvedReason(
  file: string,
  unresolvable: UnresolvableImport[],
  visitedFiles: ReadonlySet<string>,
): string {
  const base =
    'changed UI file was not in any route closure, wide-blast glob, or manual surface mapping';
  const details = selectDiscoveryDetails(file, unresolvable, visitedFiles);
  // The fix goes before the detail. Surfaces bound a printed reason, and the detail is the part
  // that can run long, so it is the part a bound may cut.
  if (details.length === 0) {
    return `${base}. ${UNPLACED_FILE_FIX}`;
  }
  return `${base}. ${UNPLACED_FILE_FIX} Discovery detail: ${details.join('; ')}`;
}
