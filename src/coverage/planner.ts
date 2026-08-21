/**
 * Coverage planning maps changed UI files to affected screens and explicit gaps.
 * It must never decide a verdict, and it must never invent route attribution.
 * Unmapped UI becomes a written gap so the gate can return not_covered.
 */
import type { AffectedScreen, Coverage, CoverageGap, FsGlob, UsablConfig } from '../contracts/index.js';
import { buildImportGraph } from './import-graph.js';
import { parseRouteManifest } from './route-manifest.js';

function matchGlob(pattern: string, file: string): boolean {
  const rx = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\x00/g, '.*') +
      '$',
  );
  return rx.test(file);
}

function isWideBlastFile(file: string, globs: string[]): boolean {
  return globs.some((glob) => matchGlob(glob, file));
}

function routeUrl(baseUrl: string, routePath: string): string {
  return baseUrl.replace(/\/$/, '') + routePath;
}

function addAffected(target: Map<string, AffectedScreen>, candidate: AffectedScreen): void {
  if (!target.has(candidate.screenId)) {
    target.set(candidate.screenId, candidate);
  }
}

function addGap(gaps: CoverageGap[], file: string): void {
  gaps.push({
    ref: file,
    state: 'unresolved',
    reason: 'changed UI file was not in any route closure, wide-blast glob, or manual surface mapping',
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
  const uiFiles = changedFiles.filter((file) => config.uiFileGlobs.some((glob) => matchGlob(glob, file)));
  if (uiFiles.length === 0) {
    return { changedFiles, affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true };
  }

  const manifest = await parseRouteManifest(fs, config.discovery);
  const affectedByScreen = new Map<string, AffectedScreen>();
  const unresolvedFiles: string[] = [];
  const gaps: CoverageGap[] = [];

  const hasWideBlast = uiFiles.some((file) => isWideBlastFile(file, config.discovery.wideBlastGlobs));
  if (hasWideBlast) {
    for (const route of manifest.routes) {
      addAffected(affectedByScreen, {
        screenId: route.screenId,
        url: routeUrl(config.appBaseUrl, route.url),
        provenance: 'wide-blast',
      });
    }
  }

  const attributedRoutes = manifest.routes.filter(
    (route): route is { screenId: string; url: string; entryFile: string } => route.entryFile !== null,
  );
  const routeEntries = [...new Set(attributedRoutes.map((route) => route.entryFile))];
  const graph = await buildImportGraph(fs, routeEntries);
  const routeClosures = new Map<string, Set<string>>();
  for (const route of attributedRoutes) {
    routeClosures.set(route.screenId, importClosure(graph, route.entryFile));
  }

  for (const file of uiFiles) {
    if (isWideBlastFile(file, config.discovery.wideBlastGlobs)) {
      continue;
    }

    let mapped = false;
    for (const route of attributedRoutes) {
      const closure = routeClosures.get(route.screenId);
      if (closure === undefined || !closure.has(file)) {
        continue;
      }
      mapped = true;
      addAffected(affectedByScreen, {
        screenId: route.screenId,
        url: routeUrl(config.appBaseUrl, route.url),
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
      addGap(gaps, file);
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
