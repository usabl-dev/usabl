/**
 * Route manifest discovery for coverage planning.
 * It prefers the sidecar because only that source can truthfully attribute entry files.
 * It must never invent entry-file attribution from router text.
 */
import type { FsGlob, UsablConfig } from '../contracts/index.js';

export interface RouteEntry {
  screenId: string;
  url: string;
  entryFile: string | null;
}

export interface RouteManifest {
  routes: RouteEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`usabl.routes.json ${field} must be a string`);
  }
  return value;
}

function expectEntryFile(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error('usabl.routes.json routes[].entryFile must be a string or null');
}

function parseSidecar(raw: string): RouteManifest {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('usabl.routes.json must be an object');
  }

  const routes = parsed['routes'];
  if (!Array.isArray(routes)) {
    throw new Error('usabl.routes.json routes must be an array');
  }

  return {
    routes: routes.map((entry, index): RouteEntry => {
      if (!isRecord(entry)) {
        throw new Error(`usabl.routes.json routes[${index}] must be an object`);
      }
      return {
        screenId: expectString(entry['screenId'], `routes[${index}].screenId`),
        url: expectString(entry['url'], `routes[${index}].url`),
        entryFile: expectEntryFile(entry['entryFile']),
      };
    }),
  };
}

function screenIdFromUrl(url: string): string {
  const trimmed = url.startsWith('/') ? url.slice(1) : url;
  if (trimmed.length === 0) return 'root';
  return trimmed.replace(/\//g, '-');
}

function parseRouterFallback(rawRouter: string): RouteManifest {
  const re = /path=["'`](\/[^"'`]*)["'`]/g;
  const routes: RouteEntry[] = [];
  for (const match of rawRouter.matchAll(re)) {
    const [, url] = match;
    if (typeof url !== 'string') continue;
    routes.push({
      screenId: screenIdFromUrl(url),
      url,
      entryFile: null,
    });
  }
  return { routes };
}

export async function parseRouteManifest(
  fs: FsGlob,
  discovery: UsablConfig['discovery'],
): Promise<RouteManifest> {
  const sidecar = await fs.readFile('usabl.routes.json');
  if (sidecar !== null) {
    return parseSidecar(sidecar);
  }

  const router = await fs.readFile(discovery.routerFile);
  if (router === null) {
    return { routes: [] };
  }

  return parseRouterFallback(router);
}
