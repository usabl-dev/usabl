/**
 * Changed test files: files under uiFileGlobs that are named like a test or sit in a test folder.
 *
 * Such a file usually holds tests or test helpers, but a screen can render it too. So it is
 * excluded only when usabl has looked at every place that could load it and found none. "No
 * import found" is evidence only when the search was complete. The planner asks, in order:
 *
 * 1. Is it a UI file? A surface lists it, a route closure reaches it, or a file that is not a test
 *    file imports it, directly or through other files. This module answers the last question with a
 *    wider import graph that starts at every file the config names as app code (see
 *    placeTestFiles), and reads imports completely (see ImportGraphOptions).
 * 2. Is it a gap? An import usabl cannot follow, in any file that graph followed, may load it: an
 *    unresolved import that names it, an import.meta.glob pattern that matches it, a dynamic import
 *    whose path is built at run time and may point to it, or a bare import a tsconfig baseUrl
 *    resolves to it. A file such a load may reach through its own imports counts too.
 * 3. Otherwise it is excluded, and listed with a reason.
 *
 * A loader usabl does not know, such as a bundler plugin, a virtual module, or a path string built
 * far from the import, can still load a test file with no trace. The ground truth states that limit.
 */
import type { FsGlob, UsablConfig } from '../contracts/index.js';
import type { AliasConfig } from './alias-config.js';
import { loadBaseUrlDirs } from './alias-config.js';
import { declaredPackageNames } from './workspace-packages.js';
import { describeLoad } from './discovery-diagnostics.js';
import { buildImportGraph, importMayLoad, type ImportGraphView, type UnresolvableImport } from './import-graph.js';

// A file named like a test, such as Button.test.tsx or Button.spec.tsx.
export function isTestNamedFile(file: string): boolean {
  return /\.(test|spec)\.[^/]+$/u.test(file);
}

// A file in a folder named test, tests, or __tests__.
export function isInTestFolder(file: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)/u.test(file);
}

export function isTestFile(file: string): boolean {
  return isInTestFolder(file) || isTestNamedFile(file);
}

const NOT_FOUND =
  'usabl found no import of it in any file outside the tests, and no import usabl could not follow could load it, ' +
  'so usabl reads it as test code and did not check it. This does not block. If a screen renders it, import it ' +
  'from that screen, or add it to the files of a surface in usabl.config.json.';

const TEST_NAMED_REASON = `This file is named like a test (.test. or .spec.). ${NOT_FOUND}`;
const TEST_FOLDER_REASON = `This file is in a test folder (test, tests, or __tests__). ${NOT_FOUND}`;

/** Why a test file nothing loads was excluded, in words that fit its kind. */
export function excludedTestFileReason(file: string): string {
  return isTestNamedFile(file) ? TEST_NAMED_REASON : TEST_FOLDER_REASON;
}

function kindOf(file: string): string {
  return isTestNamedFile(file) ? 'is named like a test (.test. or .spec.)' : 'is in a test folder (test, tests, or __tests__)';
}

// One unresolved import, as a clause.
function describeImport(entry: UnresolvableImport): string {
  return describeLoad(entry) ?? `${entry.importer} imports '${entry.specifier}', which usabl could not resolve`;
}

/**
 * Why a test file is a gap: the files that load files in a way usabl cannot follow, that this file
 * may be one of them, and what to do.
 */
export function testFileGapReason(file: string, loads: readonly UnresolvableImport[]): string {
  const clauses = [...new Set(loads.map(describeImport))].sort();
  return (
    `This file ${kindOf(file)}, and no file outside the tests imports it in a way usabl can follow. But ` +
    `${clauses.join('; ')}. This file may be one of the files loaded that way, or be imported by one of them. ` +
    'So usabl cannot tell whether a screen renders it, and did not check it. To fix it, list the file in the ' +
    'files of a surface in usabl.config.json, or load it with a plain import that usabl can resolve.'
  );
}

export type TestFilePlacement =
  // A file that is not a test file imports it, so it is a UI file.
  | { state: 'loaded' }
  // A load usabl cannot follow may reach it.
  | { state: 'maybe'; loads: UnresolvableImport[] }
  // Nothing usabl found loads it.
  | { state: 'none' };

// Every file reachable from `starts` along the graph's edges, the starts included.
function reachable(graph: ImportGraphView, starts: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    queue.push(...graph.get(current));
  }
  return seen;
}

function entryKey(entry: UnresolvableImport): string {
  return `${entry.importer}\u0000${entry.specifier}\u0000${entry.kind}`;
}

function sortedUnique(files: Iterable<string>): string[] {
  return [...new Set(files)].sort();
}

/**
 * Where each changed test file stands, by the wider graph. `files` are the changed test files no
 * surface lists and no route closure reaches. `routeEntries` are the route entry files, which
 * start the graph too. The graph is built once, and only by this call, so a run whose change holds
 * no such file never reads the files it would read.
 */
export async function placeTestFiles(
  fs: FsGlob,
  config: UsablConfig,
  routeEntries: readonly string[],
  aliases: AliasConfig,
  files: readonly string[],
  // More files that start the graph, such as the source of a workspace package a changed test file
  // sits in. Test files among them are left out.
  extraStarts: readonly string[] = [],
): Promise<Map<string, TestFilePlacement>> {
  const listed = sortedUnique(await fs.glob([...config.uiFileGlobs]));
  const options = {
    complete: true,
    baseUrlDirs: await loadBaseUrlDirs(fs, config.discovery.routerFile),
    declaredPackages: await declaredPackageNames(fs, config),
  };
  // The graph starts from every file the config names as app code, inside uiFileGlobs or not: the
  // files under uiFileGlobs that are not test files, the route entry files, the router file, the
  // files the wide-blast globs match that are not test files, and every surface's files. An
  // importer outside uiFileGlobs that the config does not name is not followed.
  const wideBlast = config.discovery.wideBlastGlobs.length === 0 ? [] : await fs.glob([...config.discovery.wideBlastGlobs]);
  const entries = sortedUnique([
    ...listed.filter((file) => !isTestFile(file)),
    ...routeEntries,
    config.discovery.routerFile.replace(/^\/+/u, ''),
    ...wideBlast.filter((file) => !isTestFile(file)),
    ...config.surfaces.flatMap((surface) => surface.files),
    ...extraStarts.filter((file) => !isTestFile(file)),
  ]);
  const loaded = await buildImportGraph(fs, entries, aliases, options);

  // The files a load usabl cannot follow may reach, and the files those import in turn. A test
  // file reached that way is followed too, so a load in it counts. The search starts again with
  // every file found, until it finds no more.
  let universe = sortedUnique([...listed, ...loaded.visited, ...files]);
  let loads = [...loaded.unresolvable];
  let starts: string[] = [];
  let maybe: ImportGraphView | null = null;
  for (;;) {
    const known = new Set(starts);
    const found = universe.filter((file) => !loaded.visited.has(file) && !known.has(file) && loads.some((entry) => importMayLoad(entry, file)));
    if (found.length === 0) break;
    starts = sortedUnique([...starts, ...found]);
    maybe = await buildImportGraph(fs, starts, aliases, options);
    universe = sortedUnique([...universe, ...maybe.visited]);
    const byKey = new Map<string, UnresolvableImport>();
    for (const entry of [...loaded.unresolvable, ...maybe.unresolvable]) byKey.set(entryKey(entry), entry);
    loads = [...byKey.keys()].sort().map((key) => byKey.get(key)!);
  }

  // For each load, the files it may reach. Worked out in memory from the graph already built.
  const reachedBy = new Map<string, Set<string>>();
  if (maybe !== null) {
    for (const entry of loads) {
      const named = universe.filter((file) => !loaded.visited.has(file) && importMayLoad(entry, file));
      reachedBy.set(entryKey(entry), reachable(maybe, named));
    }
  }

  const placements = new Map<string, TestFilePlacement>();
  for (const file of sortedUnique(files)) {
    if (loaded.visited.has(file)) {
      placements.set(file, { state: 'loaded' });
      continue;
    }
    const by = loads.filter((entry) => reachedBy.get(entryKey(entry))?.has(file) === true);
    placements.set(file, by.length > 0 ? { state: 'maybe', loads: by } : { state: 'none' });
  }
  return placements;
}
