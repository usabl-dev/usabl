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

export function buildUnresolvedReason(
  file: string,
  unresolvable: UnresolvableImport[],
  visitedFiles: ReadonlySet<string>,
): string {
  const base =
    'changed UI file was not in any route closure, wide-blast glob, or manual surface mapping';
  const details = selectDiscoveryDetails(file, unresolvable, visitedFiles);
  if (details.length === 0) {
    return base;
  }
  return `${base}. Discovery detail: ${details.join('; ')}`;
}
