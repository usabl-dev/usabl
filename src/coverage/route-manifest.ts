/**
 * Route manifest discovery for coverage planning.
 * Sidecar metadata is preferred because only authored entry files can be
 * attributed honestly. Router text fallback can recover paths, not ownership.
 * It must never invent entry-file attribution from router text.
 */
import type { FsGlob, UsablConfig } from '../contracts/index.js';
import { parseRouterFallback } from './router-parse.js';
import { configError } from '../intake/config-error.js';
import { describeIdProblem } from '../intake/id-grammar.js';

export interface RouteEntry {
  screenId: string;
  url: string;
  entryFile: string | null;
}

export interface RouteManifest {
  routes: RouteEntry[];
  // Where the route list came from, so a caller can tell a complete list from a partial one.
  // 'sidecar' is the authored usabl.routes.json and is the only source that is complete enough to
  // prove a screen id is absent. 'router' is the regex fallback, which recovers paths but is
  // documented as incomplete, so absence there proves nothing. 'none' means no source was
  // readable at all, which is also what the trust overlay produces when it suppresses a diverged
  // manifest and no router file can be read.
  source: 'sidecar' | 'router' | 'none';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw configError`usabl.routes.json ${field} must be a string`;
  }
  return value;
}

function expectRoutePathUrl(value: unknown, field: string): string {
  const url = expectString(value, field);
  // Sidecar route urls are path suffixes under appBaseUrl. Accepting a second
  // origin here would let discovery steer scans away from the operator app.
  if (!url.startsWith('/') || url.includes('@')) {
    throw configError`usabl.routes.json ${field} must start with "/" and must not contain "@"`;
  }
  return url;
}

function expectScreenId(value: unknown, field: string): string {
  const id = expectString(value, field);
  // screenId is the planner's scan identity and keys the floor, findings, waivers, and the
  // receipt, so it follows the same grammar as every other id. The message names the position
  // and code point of a refused character and never repeats the id.
  const problem = describeIdProblem(id);
  if (problem !== null) {
    throw configError`usabl.routes.json ${field} ${problem}`;
  }
  return id;
}

function expectEntryFile(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw configError`usabl.routes.json routes[].entryFile must be a string or null`;
}

function parseSidecar(raw: string): RouteManifest {
  // Corrupt sidecar data is a hard failure here so callers can fail open later.
  // Pretending parse failures mean "no routes" would silently rewrite the story.
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw configError`usabl.routes.json must be an object`;
  }

  const routes = parsed['routes'];
  if (!Array.isArray(routes)) {
    throw configError`usabl.routes.json routes must be an array`;
  }

  return {
    source: 'sidecar',
    routes: routes.map((entry, index): RouteEntry => {
      if (!isRecord(entry)) {
        throw configError`usabl.routes.json routes[${index}] must be an object`;
      }
      return {
        screenId: expectScreenId(entry['screenId'], `routes[${index}].screenId`),
        url: expectRoutePathUrl(entry['url'], `routes[${index}].url`),
        entryFile: expectEntryFile(entry['entryFile']),
      };
    }),
  };
}

function assertUniqueScreenIds(routes: RouteEntry[]): void {
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.screenId)) {
      throw configError`Duplicate screenId in route manifest: "${route.screenId}"`;
    }
    seen.add(route.screenId);
  }
}

export async function parseRouteManifest(
  fs: FsGlob,
  discovery: UsablConfig['discovery'],
): Promise<RouteManifest> {
  const sidecar = await fs.readFile('usabl.routes.json');
  // Sidecar wins whenever present, even if routes is intentionally empty.
  // Do not fall through to regex and invent a second incompatible manifest.
  if (sidecar !== null) {
    const manifest = parseSidecar(sidecar);
    // screenId is the planner's scan identity. Duplicate ids on different URLs
    // can silently map one file to the wrong screen and hide real coverage gaps.
    assertUniqueScreenIds(manifest.routes);
    return manifest;
  }

  const router = await fs.readFile(discovery.routerFile);
  if (router === null) {
    return { routes: [], source: 'none' };
  }

  const manifest = { ...parseRouterFallback(router), source: 'router' as const };
  assertUniqueScreenIds(manifest.routes);
  return manifest;
}

export async function parseConfiguredManifest(fs: FsGlob): Promise<RouteManifest | null> {
  // Load the committed usabl.routes.json sidecar as the configured manifest.
  // Returns null when the sidecar is absent so drift detection can refuse.
  const sidecar = await fs.readFile('usabl.routes.json');
  if (sidecar === null) {
    return null;
  }
  const manifest = parseSidecar(sidecar);
  assertUniqueScreenIds(manifest.routes);
  return manifest;
}

export async function parseDiscoveredManifest(
  fs: FsGlob,
  routerFile: string,
): Promise<RouteManifest | null> {
  // Parse the router file to discover the app's current routes.
  // Returns null when the router file is missing or unreadable so drift
  // detection can refuse with a manual next step rather than crash.
  // Duplicate paths are allowed here because drift compares URLs only and
  // never uses screenId, and legitimate nested routes can share paths.
  let router: string | null;
  try {
    router = await fs.readFile(routerFile);
  } catch {
    // An unreadable router (for example permission denied) is a refusal, matching the exit 2 contract.
    return null;
  }
  if (router === null) {
    return null;
  }
  return { ...parseRouterFallback(router), source: 'router' };
}
