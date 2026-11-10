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

// The name an import would use for a file: its name without the extension, or the folder name for
// an index file, since `./Dashboard` loads `Dashboard/index.tsx`.
function importName(file: string): string {
  const segments = file.split('/');
  const base = segments[segments.length - 1] ?? '';
  const stem = base.replace(/\.[^.]*$/u, '');
  if (stem === 'index' && segments.length > 1) {
    return segments[segments.length - 2] ?? stem;
  }
  return stem;
}

// The last path segment of an import, with and without its extension, so `@/tests/Dashboard` and
// `@/tests/Dashboard.js` both name a file called Dashboard.
function importLastSegments(specifier: string): string[] {
  const last = specifier.split('/').pop() ?? '';
  return [last, last.replace(/\.[^.]*$/u, '')];
}

/**
 * The imports usabl could not resolve whose last segment names this file. Any of them may be the
 * import that loads it, so "no screen reaches it" is a guess while one stands.
 */
export function unresolvedImportsNaming(file: string, unresolvable: readonly UnresolvableImport[]): UnresolvableImport[] {
  const name = importName(file);
  return unresolvable.filter((entry) => importLastSegments(entry.specifier).includes(name));
}

/**
 * The discovery detail of one file usabl could not place, in three labelled groups, most likely
 * cause first: the imports on the screens' paths that name the file, the file's own imports, and
 * every other import on the screens' paths usabl could not follow. The last group can still load
 * the file, through an alias or an index file, so it is kept, but it is labelled as imports of
 * other files. Unlabelled, it read as if the file held them. The cap counts entries, so the import
 * that names the file is never the one cut.
 */
export function selectDiscoveryDetails(
  file: string,
  unresolvable: UnresolvableImport[],
  visitedFiles: ReadonlySet<string>,
): string[] {
  const onPaths = unresolvable.filter((entry) => entry.importer !== file && visitedFiles.has(entry.importer));
  const naming = unresolvedImportsNaming(file, onPaths);
  const groups: Array<[string, UnresolvableImport[]]> = [
    ['imports that may load this file', naming],
    ['imports in this file', unresolvable.filter((entry) => entry.importer === file)],
    [
      'other imports usabl could not follow from the screens, any of which may load this file',
      onPaths.filter((entry) => !naming.includes(entry)),
    ],
  ];
  const lines: string[] = [];
  let shown = 0;
  let total = 0;
  for (const [label, entries] of groups) {
    total += entries.length;
    const room = entries.slice(0, Math.max(0, MAX_DETAIL_LINES - shown));
    if (room.length === 0) continue;
    shown += room.length;
    lines.push(`${label}: ${room.map(formatUnresolvableImport).join('; ')}`);
  }
  if (total > shown) {
    lines.push(`(${total - shown} more import resolution issue(s) not shown)`);
  }
  return lines;
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
  // No "changed": baseline passes every UI file here, changed or not.
  const base = 'This UI file is not in any route closure, wide-blast glob, or manual surface mapping';
  const details = selectDiscoveryDetails(file, unresolvable, visitedFiles);
  // The fix goes before the detail. Surfaces bound a printed reason, and the detail is the part
  // that can run long, so it is the part a bound may cut.
  if (details.length === 0) {
    return `${base}. ${UNPLACED_FILE_FIX}`;
  }
  return `${base}. ${UNPLACED_FILE_FIX} Discovery detail: ${details.join('. ')}`;
}
