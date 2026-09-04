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
import { parseRouteManifest } from './route-manifest.js';
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
  const uiFiles = changedFiles.filter(
    (file) => !isTestFile(file) && config.uiFileGlobs.some((glob) => matchGlob(glob, file)),
  );
  if (uiFiles.length === 0) {
    return { changedFiles, affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true };
  }

  const manifest = await parseRouteManifest(fs, config.discovery);
  const affectedByScreen = new Map<string, AffectedScreen>();
  const unresolvedFiles: string[] = [];
  const gaps: CoverageGap[] = [];

  const hasWideBlast = uiFiles.some((file) => isWideBlastFile(file, config.discovery.wideBlastGlobs));
  let wideBlastAttributedAnyScreen = false;
  if (hasWideBlast) {
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
    (route): route is { screenId: string; url: string; entryFile: string } => route.entryFile !== null,
  );
  const routeEntries = [...new Set(attributedRoutes.map((route) => route.entryFile))];
  const aliasConfig = await loadAliasConfig(fs);
  const graph = await buildImportGraph(fs, routeEntries, aliasConfig);
  const routeClosures = new Map<string, Set<string>>();
  for (const route of attributedRoutes) {
    routeClosures.set(route.screenId, importClosure(graph, route.entryFile));
  }

  for (const file of uiFiles) {
    const isWideBlastMatch = isWideBlastFile(file, config.discovery.wideBlastGlobs);
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
