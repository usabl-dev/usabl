/**
 * Shared router source parsing for route manifest discovery and init.
 * Regex-based and conservative: it recovers literal paths and inline components
 * only when they appear in source text. It must never invent entry files.
 */

export interface ParsedRoutePath {
  screenId: string;
  url: string;
  entryFile: null;
}

export function screenIdFromUrl(url: string): string {
  const trimmed = url.startsWith('/') ? url.slice(1) : url;
  if (trimmed.length === 0) return 'root';
  return trimmed.replace(/\//g, '-');
}

export function parseRouterFallback(rawRouter: string): { routes: ParsedRoutePath[] } {
  const attributeRe = /path=["'`](\/[^"'`]*)["'`]/g;
  const objectRe = /path:\s*["'`](\/[^"'`]*)["'`]/g;
  const urlsSeen = new Set<string>();
  const routes: ParsedRoutePath[] = [];

  for (const match of rawRouter.matchAll(attributeRe)) {
    const [, url] = match;
    if (typeof url !== 'string' || urlsSeen.has(url)) continue;
    urlsSeen.add(url);
    routes.push({
      screenId: screenIdFromUrl(url),
      url,
      entryFile: null,
    });
  }

  for (const match of rawRouter.matchAll(objectRe)) {
    const [, url] = match;
    if (typeof url !== 'string' || urlsSeen.has(url)) continue;
    urlsSeen.add(url);
    routes.push({
      screenId: screenIdFromUrl(url),
      url,
      entryFile: null,
    });
  }

  return { routes };
}

export function isRouterSource(raw: string): boolean {
  return (
    raw.includes('<Route') ||
    raw.includes('path=') ||
    raw.includes('createBrowserRouter') ||
    /path:\s*['"`]/.test(raw)
  );
}

export function parseDataRouterRoutes(
  raw: string,
): Array<{ path: string; component: string | null }> {
  const routes: Array<{ path: string; component: string | null }> = [];
  const pathMatches = raw.matchAll(/path:\s*['"`](\/[^'"`]+)['"`]/g);
  for (const pathMatch of pathMatches) {
    const routePath = pathMatch[1];
    if (typeof routePath !== 'string') {
      continue;
    }
    const start = pathMatch.index ?? 0;
    const blockEnd = raw.indexOf('}', start);
    const block = blockEnd === -1 ? raw.slice(start) : raw.slice(start, blockEnd + 1);
    const elementMatch = block.match(/element:\s*<\s*([A-Za-z_$][\w$]*)\s*\/?>/);
    routes.push({
      path: routePath,
      component: elementMatch?.[1] ?? null,
    });
  }
  return routes;
}

export function mergeParsedRoutes(
  jsxRoutes: Array<{ path: string; component: string | null }>,
  dataRoutes: Array<{ path: string; component: string | null }>,
): Array<{ path: string; component: string | null }> {
  const byPath = new Map<string, { path: string; component: string | null }>();
  for (const route of jsxRoutes) {
    byPath.set(route.path, route);
  }
  for (const route of dataRoutes) {
    if (!byPath.has(route.path)) {
      byPath.set(route.path, route);
    } else {
      const existing = byPath.get(route.path);
      if (existing !== undefined && existing.component === null && route.component !== null) {
        byPath.set(route.path, route);
      }
    }
  }
  return [...byPath.values()];
}
