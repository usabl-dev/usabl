/**
 * Coverage planning maps changed UI files to affected screens and explicit gaps.
 * It feeds the gate with evidence only. It must never mint or imply a verdict.
 * `run()` calls this planner directly, so unmapped UI must stay explicit evidence.
 * Unmapped UI becomes a written gap so the gate can return not_covered.
 */
import type { AffectedScreen, Coverage, CoverageGap, DiscoveryNote, ExcludedFile, FsGlob, UsablConfig } from '../contracts/index.js';
import { type AliasConfig, loadAppAliasConfig } from './alias-config.js';
import {
  aliasConfigConflictReason,
  buildUnresolvedReason,
  UNPLACED_FILE_FIX,
  unresolvedImportsNaming,
} from './discovery-diagnostics.js';
import { buildImportGraph, inspectDirectImports, type UnresolvableImport } from './import-graph.js';
import { dependencyChanges, EVERY_SCREEN } from './dependency-changes.js';
import { type TrustedRead, workspaceDependencyGaps } from './workspace-packages.js';
import { parseRouteManifest, type RouteEntry, type RouteManifest } from './route-manifest.js';
import { parseDocsManifest, type DocsManifest } from './docs-manifest.js';
import { assertSurfaceIds } from '../intake/surface-ids.js';
import { configError } from '../intake/config-error.js';
import { matchGlob } from '../primitives/match-glob.js';

function isWideBlastFile(file: string, globs: string[]): boolean {
  return globs.some((glob) => matchGlob(glob, file));
}

// A file named like a test, such as Button.test.tsx or Button.spec.tsx, is never a UI file.
function isTestNamedFile(file: string): boolean {
  return /\.(test|spec)\.[^/]+$/u.test(file);
}

// A folder named test, tests, or __tests__ usually holds test helpers, but a screen component can
// live there too. A file in such a folder counts as a UI file only when a screen reaches it.
function isInTestFolder(file: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)/u.test(file);
}

function isTestFile(file: string): boolean {
  return isInTestFolder(file) || isTestNamedFile(file);
}

const TEST_FOLDER_REASON =
  'This file is in a test folder (test, tests, or __tests__) and usabl found no import of it, so ' +
  'usabl reads it as test code and did not check it. This does not block. If a screen renders it, ' +
  'import it from the route entry file of that screen, or add it to the files of a surface in ' +
  'usabl.config.json.';

function testFolderGapReason(entries: UnresolvableImport[]): string {
  const imports = entries
    .map((entry) => `'${entry.specifier}' in ${entry.importer}`)
    .sort()
    .join(', ');
  return (
    'This file is in a test folder (test, tests, or __tests__), and usabl could not resolve an import ' +
    `that may load it: ${imports}. So usabl cannot tell whether a screen renders it, and did not check ` +
    `it. ${UNPLACED_FILE_FIX} Or make the import resolve, for example by adding its alias to tsconfig ` +
    'or the vite config.'
  );
}

// Every git listing usabl reads runs with -z, which never quotes a name. A changed path that still
// starts and ends with a double quote has the shape git prints for a name it quoted, and then usabl
// cannot tell which file it names. Reading it as a file outside the UI globs would let a changed
// screen pass as nothing to check, so it is a gap instead. A real name such as "draft".md does not
// have that shape and is read as the file it names.
function looksQuoted(file: string): boolean {
  return file.length >= 2 && file.startsWith('"') && file.endsWith('"');
}

const QUOTED_PATH_REASON =
  'This changed path starts and ends with a double quote. That is how git prints a name it quoted, ' +
  'so usabl cannot tell which file it names, and did not check it. It may be a real file name of ' +
  'that shape. If the list came from git, list changed files with git -z, which never quotes a name. ' +
  'If it is a real file, rename it so the name does not start and end with a double quote.';

function routeUrl(baseUrl: string, routePath: string): string {
  const joinBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const expectedOrigin = new URL(baseUrl).origin;
  const resolved = new URL(routePath, joinBaseUrl);
  // Route paths must remain on the operator app origin. A sidecar entry that
  // changes origin would mint dishonest scan targets outside declared scope.
  if (resolved.origin !== expectedOrigin) {
    throw configError`route url must stay on app origin: ${routePath}`;
  }
  return resolved.toString();
}

function addAffected(target: Map<string, AffectedScreen>, candidate: AffectedScreen): void {
  if (!target.has(candidate.screenId)) {
    target.set(candidate.screenId, candidate);
  }
}

function manualUrlOverride(config: UsablConfig, file: string, screenId: string): string | null {
  for (const surface of config.surfaces) {
    if (surface.id === screenId && surface.files.includes(file)) {
      return surface.url;
    }
  }
  return null;
}

/**
 * Refuses any screen id that could stand for more than one screen.
 *
 * Three sources mint screen ids and all three land in the same identity space: operator surfaces,
 * discovered routes, and docs manifest pages. App coverage and docs coverage are concatenated by
 * the caller, and downstream the id alone keys floor identity, finding identity, waiver matching,
 * applicability, and source lookup. So one id shared by two screens does not merely drop a screen
 * from the scan. It also lets a floor entry belonging to one screen absorb a genuinely new barrier
 * on the other, which reads as carried debt and mints a verified receipt over a real failure.
 * Each source checks itself for duplicates. Nothing checked across them until here.
 *
 * A surface and a discovered route may share an id, because that is how a surface overrides the
 * scan url for a screen discovery already owns. usabl does not try to work out whether a given
 * pair is that override or two different screens. It cannot: a url does not determine a screen.
 * Applications select screens by query, fragment, trailing slash, and userinfo, servers do not
 * treat percent spellings as interchangeable, and a redirect can send two requests for one url to
 * two different screens depending on session, server state, or time. Even exact string equality
 * proves only that the same address was requested. So the config declares the relationship with
 * `overridesDiscoveredRoute` and nothing is inferred from the url at all.
 *
 * No such declaration exists for docs pages, because a docs page is never an alias for an app
 * screen, so any overlap involving a docs page is refused outright.
 */
function assertScreenIdsAreUnambiguous(
  config: UsablConfig,
  manifest: RouteManifest,
  docsPageIds: string[],
): void {
  const routeById = new Map<string, RouteEntry>();
  for (const route of manifest.routes) {
    if (!routeById.has(route.screenId)) {
      routeById.set(route.screenId, route);
    }
  }

  config.surfaces.forEach((surface, index) => {
    const route = routeById.get(surface.id);

    if (route !== undefined && surface.overridesDiscoveredRoute !== true) {
      throw configError`surfaces[${index}].id "${surface.id}" is also the screen id of the discovered route "${route.url}". usabl tracks coverage by screen id, so one of the two would never be scanned and the run would still report both as covered. If this surface is that same screen, add "overridesDiscoveredRoute": true to it. If it is a different screen, give it a different id. usabl does not compare the two urls, because a url does not determine which screen renders.`;
    }

    // A declaration that overrides nothing reads as wired up while the surface stands alone, so
    // the intended url override never applies. Only an authored sidecar lists routes completely
    // enough to prove an id is absent from it. Router-text discovery is documented as recovering
    // paths but not ownership, and 'none' is also what the trust overlay leaves behind when it
    // suppresses a diverged manifest, so absence proves nothing in either of those and saying so
    // would throw away the findings of a run that could still report honestly.
    if (route === undefined && surface.overridesDiscoveredRoute === true && manifest.source === 'sidecar') {
      throw configError`surfaces[${index}] sets overridesDiscoveredRoute, but usabl.routes.json has no route with the screen id "${surface.id}", so the declaration overrides nothing and this surface url will not be used for a discovered screen. Correct the id to the route you meant, or remove the declaration.`;
    }
  });

  // Docs pages share the identity space with both other sources and have no override relationship
  // with either, so any overlap is two screens under one id.
  const surfaceIds = new Set(config.surfaces.map((surface) => surface.id));
  for (const pageId of docsPageIds) {
    if (surfaceIds.has(pageId)) {
      throw configError`usabl.docs.json has a page with the id "${pageId}", which is also a surfaces[].id in usabl.config.json. A docs page and an app screen are never the same screen, and usabl keys coverage, floor identity, and waivers by that id alone, so one would absorb the other's findings. Rename one of them.`;
    }
    if (routeById.has(pageId)) {
      throw configError`usabl.docs.json has a page with the id "${pageId}", which is also the screen id of a discovered route. A docs page and an app screen are never the same screen, and usabl keys coverage, floor identity, and waivers by that id alone, so one would absorb the other's findings. Rename the docs page, or rename the route.`;
    }
  }
}

function importClosure(graph: { get(file: string): string[] }, entryFile: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current !== 'string' || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const next of graph.get(current)) {
      queue.push(next);
    }
  }
  return seen;
}

// One note per alias import that resolved more than one way and reaches a changed UI file, so the
// screens it added or kept are explained. Sorted by file, then import, so the list is stable.
function aliasConflictNotes(graph: Awaited<ReturnType<typeof buildImportGraph>>, uiFiles: readonly string[]): DiscoveryNote[] {
  const changed = new Set(uiFiles);
  const notes: Array<DiscoveryNote & { specifier: string }> = [];
  for (const entry of graph.unresolvable) {
    if (entry.kind !== 'alias-conflict') continue;
    const reaches = entry.candidates.some((candidate) => [...importClosure(graph, candidate)].some((file) => changed.has(file)));
    if (reaches) notes.push({ ref: entry.importer, specifier: entry.specifier, reason: aliasConfigConflictReason(entry) });
  }
  // Plain code-unit order, so the order never depends on the machine's locale.
  const key = (note: { ref: string; specifier: string }): string => `${note.ref}\u0000${note.specifier}`;
  notes.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return notes.map(({ ref, reason }) => ({ ref, reason }));
}

interface RouteGraph {
  graph: Awaited<ReturnType<typeof buildImportGraph>>;
  aliasConfig: AliasConfig;
  // The import closure of each route entry file, keyed by screen id.
  closures: Map<string, Set<string>>;
}

async function buildRouteGraph(
  fs: FsGlob,
  attributedRoutes: ReadonlyArray<{ screenId: string; entryFile: string }>,
  routerFile: string,
): Promise<RouteGraph> {
  const routeEntries = [...new Set(attributedRoutes.map((route) => route.entryFile))];
  // The aliases come from the nearest tsconfig and the nearest Vite config at or above the router
  // file, and from the repository root configs too. An import the two sets map to different places
  // is followed both ways and disclosed. See loadAppAliasConfig.
  const aliasConfig = await loadAppAliasConfig(fs, routerFile);
  const graph = await buildImportGraph(fs, routeEntries, aliasConfig);
  const closures = new Map<string, Set<string>>();
  for (const route of attributedRoutes) {
    closures.set(route.screenId, importClosure(graph, route.entryFile));
  }
  return { graph, aliasConfig, closures };
}

/**
 * `docsManifest` is the parsed usabl.docs.json, when the caller has already read it. run() reads
 * it once and passes it here and to the docs planner, so the file is parsed once per run and both
 * planners see the same manifest. Leave it out and this planner reads it from `fs` itself.
 */
export async function computeCoverage(
  fs: FsGlob,
  config: UsablConfig,
  changedFiles: string[],
  docsManifest?: DocsManifest | null,
  // Reads a file at the trusted ref. The workspace manifests are read from it as well as from the
  // tree, so a change cannot unlink the app from a workspace package it also edits.
  trustedRead?: TrustedRead,
): Promise<Coverage> {
  // affectedByScreen below is keyed by surface id, so a blank or repeated id silently drops a
  // screen while its changed files still read as mapped. Config parsing refuses that document,
  // but this planner takes a UsablConfig value from any caller, so it checks the invariant it
  // depends on rather than trusting that every caller parsed first. Refusing is honest here:
  // the run fails open and discloses, which is what an unscannable config deserves.
  assertSurfaceIds(config.surfaces);

  // Identity is checked before the idle return, not after. A run where no app UI file changed can
  // still scan docs pages, and a floor entry keyed by an id shared with an app screen absorbs a
  // docs finding whether or not this planner found anything to do.
  const manifest = await parseRouteManifest(fs, config.discovery);
  const docs = docsManifest === undefined ? await parseDocsManifest(fs) : docsManifest;
  assertScreenIdsAreUnambiguous(config, manifest, (docs?.pages ?? []).map((page) => page.pageId));

  const quotedFiles = changedFiles.filter(looksQuoted);
  const listedFiles = changedFiles.filter((file) => !looksQuoted(file));
  const globbedFiles = listedFiles.filter(
    (file) => !isTestNamedFile(file) && config.uiFileGlobs.some((glob) => matchGlob(glob, file)),
  );

  const attributedRoutes = manifest.routes.filter(
    // Router fallback routes have entryFile: null, so they cannot truthfully
    // participate in route-graph closure matching.
    (route): route is { screenId: string; url: string; entryFile: string } => route.entryFile !== null,
  );
  // The graph is built once, and only when something needs it: a file in a test folder asks
  // whether a screen reaches it, and the screen mapping below asks which screens do.
  let routeGraph: Promise<RouteGraph> | null = null;
  const loadRouteGraph = (): Promise<RouteGraph> => {
    routeGraph ??= buildRouteGraph(fs, attributedRoutes, config.discovery.routerFile);
    return routeGraph;
  };

  // A file in a test folder that a screen reaches is a UI file like any other. One no screen
  // reaches is disclosed as excluded, not a gap, so a change to test helpers alone stays nothing
  // to check. A surface that lists the file in its files reaches it by the operator's word.
  // One no screen reaches but an unresolved import may load is a gap, because "no screen reaches
  // it" is then a guess.
  const testFolderFiles = globbedFiles.filter(isInTestFolder);
  const reachedTestFolderFiles = new Set<string>();
  const testFolderGaps: CoverageGap[] = [];
  const excludedFiles: ExcludedFile[] = [];
  if (testFolderFiles.length > 0) {
    const { graph, closures } = await loadRouteGraph();
    for (const file of [...testFolderFiles].sort()) {
      const listedBySurface = config.surfaces.some((surface) => surface.files.includes(file));
      if (listedBySurface || [...closures.values()].some((closure) => closure.has(file))) {
        reachedTestFolderFiles.add(file);
        continue;
      }
      const naming = unresolvedImportsNaming(file, graph.unresolvable);
      if (naming.length > 0) {
        testFolderGaps.push({ ref: file, state: 'unresolved', reason: testFolderGapReason(naming) });
      } else {
        excludedFiles.push({ ref: file, reason: TEST_FOLDER_REASON });
      }
    }
  }
  const uiFiles = globbedFiles.filter((file) => !isInTestFolder(file) || reachedTestFolderFiles.has(file));
  // Omitted when empty, so a Coverage with nothing excluded has the same shape it always had.
  const excluded = excludedFiles.length === 0 ? {} : { excludedFiles };
  // In a monorepo, a change in a workspace package the app depends on matches none of the app's
  // uiFileGlobs, while the app may render it. It is written down as a gap, so it never reads as
  // idle. See workspace-packages.ts for why it is not mapped to screens.
  const otherFiles = listedFiles.filter((file) => !isTestFile(file) && !uiFiles.includes(file));
  const workspaceGaps = await workspaceDependencyGaps(fs, config, otherFiles, trustedRead);
  // A bump of the UI component library touches the app's package.json and the lockfile, and
  // neither matches uiFileGlobs, while the new version can change every screen. Such a change is
  // wide blast, with a reason that names each file. See dependency-changes.ts.
  const dependencies = await dependencyChanges(fs, config, otherFiles, trustedRead);
  const dependencyReason = dependencies.length === 0 ? null : [...dependencies.map((change) => change.why), EVERY_SCREEN].join(' ');
  // No UI-touching files means idle. That is not the same claim as "covered".
  if (
    uiFiles.length === 0 &&
    quotedFiles.length === 0 &&
    testFolderGaps.length === 0 &&
    workspaceGaps.length === 0 &&
    dependencyReason === null
  ) {
    return { changedFiles, affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true, ...excluded };
  }
  const quotedGaps: CoverageGap[] = quotedFiles.map((file) => ({ ref: file, state: 'unresolved', reason: QUOTED_PATH_REASON }));
  const unresolvedFiles: string[] = [
    ...quotedFiles,
    ...testFolderGaps.map((gap) => gap.ref),
    ...workspaceGaps.map((gap) => gap.ref),
  ];
  const gaps: CoverageGap[] = [...quotedGaps, ...testFolderGaps, ...workspaceGaps];
  if (uiFiles.length === 0 && dependencyReason === null) {
    return { changedFiles, affected: [], unresolvedFiles, gaps, nothingToCheck: false, ...excluded };
  }
  const affectedByScreen = new Map<string, AffectedScreen>();
  const wideBlastReason = dependencyReason === null ? {} : { reason: dependencyReason };

  const hasWideBlast = dependencyReason !== null || uiFiles.some((file) => isWideBlastFile(file, config.discovery.wideBlastGlobs));
  let wideBlastAttributedAnyScreen = false;
  if (hasWideBlast) {
    // A shell or global file can influence any route, so queue every discovered
    // route instead of pretending we can prove a single-screen blast radius.
    const affectedCountBeforeWideBlast = affectedByScreen.size;
    for (const route of manifest.routes) {
      addAffected(affectedByScreen, {
        screenId: route.screenId,
        url: routeUrl(config.appBaseUrl, route.url),
        provenance: 'wide-blast',
        ...wideBlastReason,
      });
    }
    wideBlastAttributedAnyScreen = affectedByScreen.size > affectedCountBeforeWideBlast;
    // The router fallback can find a route whose path yields no valid screen id. Wide blast would
    // have queued that route, so leaving it out in silence would report the blast as covered
    // while one discovered screen was never opened. It is written down as a gap instead, with
    // the position and code point of the refused character and never the id itself, and the
    // gate reads it as not covered. The route url is the ref, as a file path is for other gaps.
    for (const route of manifest.unusable ?? []) {
      gaps.push({
        ref: route.url,
        state: 'skipped',
        reason: `${route.reason} Name this route in usabl.routes.json with a visible screen id of its own, or change the route path.`,
      });
    }
    // The same holds for a route the router fallback could not read, and for a router file that
    // does not parse: wide blast would have queued those routes, so the blast is not covered. The
    // ref names the router file and the line, which is where the operator looks.
    for (const route of manifest.unreadable ?? []) {
      gaps.push({
        ref: route.line === null || route.wholeFile === true ? route.file : `${route.file}:${route.line}`,
        state: 'skipped',
        reason: `${route.reason} Write the routes into usabl.routes.json, which usabl reads instead of the router file.`,
      });
    }
  }

  if (dependencyReason !== null) {
    // A dependency change reaches every screen, so every configured surface is queued too, not
    // only the ones that list a changed file. Each is queued by its screen id, never skipped for a
    // url a route or another surface already has: a surface carries its own readiness signal and
    // requirements, and a url does not determine which screen renders. A surface that overrides a
    // discovered route has that route's id, so addAffected keeps one entry for the two.
    for (const surface of config.surfaces) {
      addAffected(affectedByScreen, { screenId: surface.id, url: surface.url, provenance: 'wide-blast', reason: dependencyReason });
    }
    // With no route and no surface there is no screen to check, which is not the same as nothing
    // to check. Each file is written down as a gap.
    if (affectedByScreen.size === 0) {
      for (const change of dependencies) {
        unresolvedFiles.push(change.file);
        gaps.push({
          ref: change.file,
          state: 'unresolved',
          reason:
            `${change.why} A dependency change can change every screen, but usabl found no screen to check: no route was discovered and no surface is configured. ` +
            'Add the routes of the app to usabl.routes.json, or list its screens as surfaces in usabl.config.json.',
        });
      }
    }
  }

  // Graph unresolvable entries are diagnostics about discovery fidelity.
  // They are not coverage gaps unless a changed UI file maps to no screen.
  const { graph, aliasConfig, closures: routeClosures } = await loadRouteGraph();

  for (const file of uiFiles) {
    const isWideBlastMatch = isWideBlastFile(file, config.discovery.wideBlastGlobs);
    // Wide-blast already covered discovered routes for this file, so per-file
    // route-graph matching adds no new evidence.
    // Manual surfaces are still additive because operators can declare URLs that
    // discovery did not find and those URLs still need scans.
    // An empty route list is not coverage evidence, so this branch only applies
    // when wide-blast actually attributed at least one discovered route.
    // A surface that lists the file is queued by its screen id, never skipped for a url a route or
    // another surface already has: it carries its own readiness signal and requirements.
    if (isWideBlastMatch && wideBlastAttributedAnyScreen) {
      for (const surface of config.surfaces) {
        if (!surface.files.includes(file)) {
          continue;
        }
        addAffected(affectedByScreen, {
          screenId: surface.id,
          url: surface.url,
          provenance: 'manual',
        });
      }
      continue;
    }

    let mapped = false;
    for (const route of attributedRoutes) {
      const closure = routeClosures.get(route.screenId);
      if (closure === undefined || !closure.has(file)) {
        continue;
      }
      mapped = true;
      // Route graph decides affected screen identity. Manual surfaces may still
      // override that screen's scan URL so query variants remain operator-controlled.
      const url = manualUrlOverride(config, file, route.screenId) ?? routeUrl(config.appBaseUrl, route.url);
      addAffected(affectedByScreen, {
        screenId: route.screenId,
        url,
        provenance: 'route-graph',
        importChain: [route.entryFile, file],
      });
    }

    if (mapped) {
      continue;
    }

    let manualMatch = false;
    // Manual surfaces are additive fallback after discovery. They can rescue
    // known files, but they never replace route discovery or hide unmapped UI.
    for (const surface of config.surfaces) {
      if (!surface.files.includes(file)) {
        continue;
      }
      manualMatch = true;
      addAffected(affectedByScreen, {
        screenId: surface.id,
        url: surface.url,
        provenance: 'manual',
      });
    }

    if (!manualMatch) {
      // A changed UI file with no route-graph, wide-blast, or manual mapping is a
      // real coverage gap. Silent empties would let the gate misread this as safe.
      unresolvedFiles.push(file);
      const directDiagnostics = await inspectDirectImports(fs, file, aliasConfig);
      const combinedUnresolvable = [...graph.unresolvable, ...directDiagnostics];
      gaps.push({
        ref: file,
        state: 'unresolved',
        reason: buildUnresolvedReason(file, combinedUnresolvable, graph.visited),
      });
    }
  }

  const discoveryNotes = aliasConflictNotes(graph, uiFiles);
  return {
    changedFiles,
    affected: [...affectedByScreen.values()],
    unresolvedFiles,
    gaps,
    nothingToCheck: false,
    ...excluded,
    // Omitted when empty, so a Coverage with nothing to disclose has the same shape it always had.
    ...(discoveryNotes.length === 0 ? {} : { discoveryNotes }),
  };
}
