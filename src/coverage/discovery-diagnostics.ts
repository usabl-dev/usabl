/**
 * Formats import-graph unresolvable entries into human-readable discovery detail.
 * Used when a changed file lands in unresolvedFiles so the gap reason names a fix path.
 */
import { importMayLoad, type UnresolvableImport } from './import-graph.js';

const MAX_DETAIL_LINES = 3;

// What usabl read of a glob call and which files it may load, in words that say what is true.
function globWhich(entry: Extract<UnresolvableImport, { kind: 'glob-import' }>): string {
  if (entry.patterns === null) {
    if (entry.unread === 'base') {
      return 'and its options set base, which moves where its patterns start and which usabl does not read, so it may load any file';
    }
    if (entry.unread === 'start') {
      return 'and usabl cannot resolve where one of its patterns starts (an alias usabl does not read, or a leading / with no Vite root), so it may load any file';
    }
    return 'and its argument is not a string or a list of strings that usabl can read, so it may load any file';
  }
  const matches = `which loads every file that matches ${entry.patterns.join(', ')}`;
  if (entry.widened === undefined) return matches;
  return (
    `${matches}. usabl does not evaluate the syntax in ${entry.widened.join(', ')}, ` +
    'so for each of those it counts every file in the folder above that syntax'
  );
}

/**
 * One load usabl cannot follow, as a clause that names the file that holds it, what it does, and
 * which files it may load. Null for an import that did not resolve, which formatUnresolvableImport
 * describes.
 */
export function describeLoad(entry: UnresolvableImport): string | null {
  if (entry.kind === 'glob-import') {
    return `${entry.importer} loads files with ${entry.specifier}, ${globWhich(entry)}`;
  }
  if (entry.kind === 'dynamic-import') {
    const under = entry.prefixes === null ? [] : entry.prefixes.map((prefix) => `under ${prefix}`);
    const named = (entry.nameStarts ?? []).map(
      (start) => `whose path holds a folder or name that starts with ${start}, since no package explains that start and usabl may not read the alias that does`,
    );
    const which =
      entry.prefixes === null
        ? 'and usabl cannot tell where that path points, so it may load any file'
        : `so it may load any file ${[...under, ...named].join(', or any file ')}`;
    const how = /^require\s*\.\s*context/u.test(entry.specifier)
      ? 'loads the modules of a folder with'
      : 'loads a module with';
    const built = /^require\s*\.\s*context/u.test(entry.specifier) ? '' : ', whose path is built when the code runs,';
    return `${entry.importer} ${how} ${entry.specifier}${built} ${which}`;
  }
  if (entry.kind === 'bare-unknown') {
    const why = entry.specifier.startsWith('#')
      ? 'a package.json "imports" entry maps it, which usabl does not read'
      : 'no package.json usabl reads declares that package, and no alias usabl reads maps it, so it may be an alias usabl did not read';
    return `${entry.importer} imports '${entry.specifier}', and ${why}`;
  }
  if (entry.kind === 'base-url') {
    return (
      `${entry.importer} imports '${entry.specifier}', which the tsconfig baseUrl resolves to ${entry.candidates.join(', ')}, ` +
      'and usabl cannot tell whether the bundler reads baseUrl'
    );
  }
  return null;
}

export function formatUnresolvableImport(entry: UnresolvableImport): string {
  const load = describeLoad(entry);
  if (load !== null) {
    return load;
  }
  if (entry.kind === 'alias-unconfigured') {
    return `could not resolve '${entry.specifier}' in ${entry.importer}: no alias mapping found in tsconfig or vite config`;
  }
  if (entry.kind === 'alias-unmapped') {
    return `could not resolve '${entry.specifier}' in ${entry.importer}: no alias mapping matches this prefix in tsconfig or vite config`;
  }
  if (entry.kind === 'alias-conflict') {
    return aliasConflictText(entry);
  }
  if (entry.kind === 'ambiguous-candidates') {
    return `could not resolve '${entry.specifier}' in ${entry.importer}: more than one file matches (${entry.candidates.join(', ')}), and usabl does not know which one the bundler loads, so it follows all of them. Write the import with the file's extension`;
  }
  return `could not resolve '${entry.specifier}' in ${entry.importer}: resolved path has no matching file on disk`;
}

/**
 * The sentence for an alias import that resolved more than one way. The app's configs and the
 * repository root's configs map it to different places, and usabl cannot run the build to learn
 * which one wins.
 */
export function aliasConfigConflictReason(entry: { specifier: string; targets: readonly string[]; candidates: readonly string[] }): string {
  return (
    `'${entry.specifier}' resolves more than one way: the tsconfig and Vite configs usabl reads map it to ${entry.targets.join(', ')}. ` +
    `usabl cannot tell which one the build uses, so it follows every file found (${entry.candidates.join(', ')}). ` +
    'Make the app configs and the repository root configs map this alias to one folder'
  );
}

function aliasConflictText(entry: Extract<UnresolvableImport, { kind: 'alias-conflict' }>): string {
  return `in ${entry.importer}: ${aliasConfigConflictReason(entry)}`;
}

/**
 * The imports usabl could not follow that may load this file: one that did not resolve and whose
 * last segment names it, or a glob, a dynamic import, or a baseUrl import that covers it (see
 * importMayLoad). Any of them may be the import that loads it, so "no screen reaches it" is a
 * guess while one stands.
 */
export function unresolvedImportsNaming(file: string, unresolvable: readonly UnresolvableImport[]): UnresolvableImport[] {
  return unresolvable.filter((entry) => importMayLoad(entry, file));
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
  // Said in place of the usual fix, such as who imports a test file that counts as a UI file.
  note?: string,
): string {
  // No "changed": baseline passes every UI file here, changed or not.
  const base = 'This UI file is not in any route closure, wide-blast glob, or manual surface mapping';
  const details = selectDiscoveryDetails(file, unresolvable, visitedFiles);
  const fix = note ?? UNPLACED_FILE_FIX;
  // The fix goes before the detail. Surfaces bound a printed reason, and the detail is the part
  // that can run long, so it is the part a bound may cut.
  if (details.length === 0) {
    return `${base}. ${fix}`;
  }
  return `${base}. ${fix} Discovery detail: ${details.join('. ')}`;
}
