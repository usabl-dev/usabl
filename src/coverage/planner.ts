/**
 * Coverage planning maps changed UI files to affected screens and explicit gaps.
 * It feeds the gate with evidence only. It must never mint or imply a verdict.
 * `run()` calls this planner directly, so unmapped UI must stay explicit evidence.
 * Unmapped UI becomes a written gap so the gate can return not_covered.
 */
import type { AffectedScreen, Coverage, CoverageGap, FsGlob, UsablConfig } from '../contracts/index.js';
import { loadAliasConfig } from './alias-config.js';
import { buildUnresolvedReason } from './discovery-diagnostics.js';
import { buildImportGraph, inspectDirectImports } from './import-graph.js';
import { parseRouteManifest, type RouteEntry } from './route-manifest.js';
import { assertSurfaceIds, forMessage } from '../intake/surface-ids.js';
import { matchGlob } from '../primitives/match-glob.js';

function isWideBlastFile(file: string, globs: string[]): boolean {
  return globs.some((glob) => matchGlob(glob, file));
}

function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)/u.test(file) || /\.(test|spec)\.[^/]+$/u.test(file);
}

function routeUrl(baseUrl: string, routePath: string): string {
  const joinBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const expectedOrigin = new URL(baseUrl).origin;
  const resolved = new URL(routePath, joinBaseUrl);
  // Route paths must remain on the operator app origin. A sidecar entry that
  // changes origin would mint dishonest scan targets outside declared scope.
  if (resolved.origin !== expectedOrigin) {
    throw new Error(`route url must stay on app origin: ${routePath}`);
  }
  return resolved.toString();
}

function addAffected(target: Map<string, AffectedScreen>, candidate: AffectedScreen): void {
  if (!target.has(candidate.screenId)) {
    target.set(candidate.screenId, candidate);
  }
}

function hasAffectedUrl(target: Map<string, AffectedScreen>, url: string): boolean {
  return [...target.values()].some((screen) => screen.url === url);
}

function manualUrlOverride(config: UsablConfig, file: string, screenId: string): string | null {
  for (const surface of config.surfaces) {
    if (surface.id === screenId && surface.files.includes(file)) {
      return surface.url;
    }
  }
  return null;
}

// Reduces a scan target to the screen it opens: origin and path, with query, fragment, and a
// trailing slash dropped. Returns null when the string is not a url this planner could resolve.
function screenAddress(url: string, baseUrl: string): string | null {
  try {
    const joinBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const resolved = new URL(url, joinBaseUrl);
    const path =
      resolved.pathname.length > 1 && resolved.pathname.endsWith('/')
        ? resolved.pathname.slice(0, -1)
        : resolved.pathname;
    return `${resolved.origin}${path}`;
  } catch {
    return null;
  }
}

/**
 * Refuses a manual surface that takes a discovered route's screen id for a different screen.
 *
 * Surface ids and route screen ids are one namespace, because both are written into the same
 * affected-screen map, so uniqueness inside each set is not enough. A manual surface is allowed
 * to reuse a route's screen id: that is how manualUrlOverride lets an operator keep control of
 * the scan url for a screen discovery already owns, which is what makes query variants like
 * ?variant=fixed possible. What that override means is "same screen, different url to reach it",
 * so the two have to be the same screen. Same origin and same path is that test. Query and
 * fragment may differ, since varying them is the whole point of the override.
 *
 * A different path is a different screen wearing an id that is already taken. The map keeps
 * whichever arrives first and drops the other, while the dropped screen's changed files still
 * count as mapped, so the run reports two changed screens as covered after scanning one. Refuse
 * it here, where both sets of ids are known for the first time.
 */
function assertSurfacesDoNotTakeRouteScreens(config: UsablConfig, routes: RouteEntry[]): void {
  const routeById = new Map<string, RouteEntry>();
  for (const route of routes) {
    if (!routeById.has(route.screenId)) {
      routeById.set(route.screenId, route);
    }
  }

  config.surfaces.forEach((surface, index) => {
    const route = routeById.get(surface.id);
    if (route === undefined) {
      return;
    }
    const surfaceAddress = screenAddress(surface.url, config.appBaseUrl);
    const routeAddress = screenAddress(route.url, config.appBaseUrl);
    if (surfaceAddress !== null && routeAddress === surfaceAddress) {
      return;
    }
    throw new Error(
      `surfaces[${index}].id "${forMessage(surface.id)}" is already the screen id of the ` +
        `discovered route "${forMessage(route.url)}", but surfaces[${index}].url ` +
        `"${forMessage(surface.url)}" opens a different screen. usabl tracks coverage by screen ` +
        `id, so the id would name one of the two screens and the other would never be scanned. ` +
        `A surface may reuse a route's screen id only to change the query or fragment of that ` +
        `same screen's url. Give this surface its own id, or point it at the route's path.`,
    );
  });
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

export async function computeCoverage(fs: FsGlob, config: UsablConfig, changedFiles: string[]): Promise<Coverage> {
  // affectedByScreen below is keyed by surface id, so a blank or repeated id silently drops a
  // screen while its changed files still read as mapped. Config parsing refuses that document,
  // but this planner takes a UsablConfig value from any caller, so it checks the invariant it
  // depends on rather than trusting that every caller parsed first. Refusing is honest here:
  // the run fails open and discloses, which is what an unscannable config deserves.
  assertSurfaceIds(config.surfaces);

  const uiFiles = changedFiles.filter(
    (file) => !isTestFile(file) && config.uiFileGlobs.some((glob) => matchGlob(glob, file)),
  );
  // No UI-touching files means idle. That is not the same claim as "covered".
  if (uiFiles.length === 0) {
    return { changedFiles, affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true };
  }

  const manifest = await parseRouteManifest(fs, config.discovery);
  // parseRouteManifest has checked that route screen ids are unique among themselves, and
  // assertSurfaceIds checked the same for surfaces. Neither sees the other set, and both write
  // into the one map below, so the cross-set check can only happen here.
  assertSurfacesDoNotTakeRouteScreens(config, manifest.routes);

  const affectedByScreen = new Map<string, AffectedScreen>();
  const unresolvedFiles: string[] = [];
  const gaps: CoverageGap[] = [];

  const hasWideBlast = uiFiles.some((file) => isWideBlastFile(file, config.discovery.wideBlastGlobs));
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
      });
    }
    wideBlastAttributedAnyScreen = affectedByScreen.size > affectedCountBeforeWideBlast;
  }

  const attributedRoutes = manifest.routes.filter(
    // Regex fallback routes have entryFile: null, so they cannot truthfully
    // participate in route-graph closure matching.
    (route): route is { screenId: string; url: string; entryFile: string } => route.entryFile !== null,
  );
  const routeEntries = [...new Set(attributedRoutes.map((route) => route.entryFile))];
  const aliasConfig = await loadAliasConfig(fs);
  const graph = await buildImportGraph(fs, routeEntries, aliasConfig);
  // Graph unresolvable entries are diagnostics about discovery fidelity.
  // They are not coverage gaps unless a changed UI file maps to no screen.
  const routeClosures = new Map<string, Set<string>>();
  for (const route of attributedRoutes) {
    routeClosures.set(route.screenId, importClosure(graph, route.entryFile));
  }

  for (const file of uiFiles) {
    const isWideBlastMatch = isWideBlastFile(file, config.discovery.wideBlastGlobs);
    // Wide-blast already covered discovered routes for this file, so per-file
    // route-graph matching adds no new evidence.
    // Manual surfaces are still additive because operators can declare URLs that
    // discovery did not find and those URLs still need scans.
    // An empty route list is not coverage evidence, so this branch only applies
    // when wide-blast actually attributed at least one discovered route.
    if (isWideBlastMatch && wideBlastAttributedAnyScreen) {
      for (const surface of config.surfaces) {
        if (!surface.files.includes(file) || hasAffectedUrl(affectedByScreen, surface.url)) {
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

  return {
    changedFiles,
    affected: [...affectedByScreen.values()],
    unresolvedFiles,
    gaps,
    nothingToCheck: false,
  };
}
