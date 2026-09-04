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

// Discovers data-router route URLs, scoped to the create*Router(...) argument so an unrelated
// object elsewhere in the module cannot be read as a route. It never attributes a component:
// slicing to the next brace binds a nested child's element to its parent route, so entry-file
// attribution stays null and each route is a URL-only discovery. route-manifest's rule holds here
// too: never invent entry-file attribution from router text.
export function parseDataRouterRoutes(
  raw: string,
): Array<{ path: string; component: string | null }> {
  const region = extractRouterCallArg(raw);
  if (region === null) {
    return [];
  }
  const routes: Array<{ path: string; component: string | null }> = [];
  const seen = new Set<string>();
  for (const pathMatch of region.matchAll(/path:\s*['"`](\/[^'"`]+)['"`]/g)) {
    const routePath = pathMatch[1];
    if (typeof routePath !== 'string' || seen.has(routePath)) {
      continue;
    }
    seen.add(routePath);
    routes.push({ path: routePath, component: null });
  }
  return routes;
}

// Returns the balanced-paren argument of the first create*Router(...) call, or null.
function extractRouterCallArg(raw: string): string | null {
  const marker = raw.match(/\bcreate(?:Browser|Hash|Memory)Router\s*\(/);
  if (marker?.index === undefined) {
    return null;
  }
  const start = marker.index + marker[0].length - 1;
  let depth = 0;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
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
