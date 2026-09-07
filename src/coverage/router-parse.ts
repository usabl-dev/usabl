/**
 * Shared router source parsing for route manifest discovery and init.
 * Regex-based and conservative: it recovers literal paths and inline components
 * only when they appear in source text. It must never invent entry files.
 */
import { describeIdProblem } from '../intake/id-grammar.js';

export interface ParsedRoutePath {
  screenId: string;
  url: string;
  entryFile: null;
}

/** A route whose path cannot be turned into a screen id, with the reason in config-message words. */
export interface UnusableRoute {
  url: string;
  reason: string;
}

export function screenIdFromUrl(url: string): string {
  const trimmed = url.startsWith('/') ? url.slice(1) : url;
  if (trimmed.length === 0) return 'root';
  return trimmed.replace(/\//g, '-');
}

/**
 * Derives a screen id from a route path and checks it against the shared id grammar in one step.
 *
 * A route literal in application source is not a policy file, so nothing has validated it before
 * this point, and a raw bidi control or a blank glyph in the path would ride straight into the id
 * and from there into floors, findings, waivers, and receipts. Every place that turns a path into
 * an id goes through here, so a derived id that no parser would accept is never minted. The
 * problem text names the position and code point and never repeats the id.
 */
export function deriveScreenId(url: string): { ok: true; screenId: string } | { ok: false; problem: string } {
  const screenId = screenIdFromUrl(url);
  const problem = describeIdProblem(screenId);
  return problem === null ? { ok: true, screenId } : { ok: false, problem };
}

export function parseRouterFallback(rawRouter: string): { routes: ParsedRoutePath[]; unusable: UnusableRoute[] } {
  const attributeRe = /path=["'`](\/[^"'`]*)["'`]/g;
  const objectRe = /path:\s*["'`](\/[^"'`]*)["'`]/g;
  const urlsSeen = new Set<string>();
  const routes: ParsedRoutePath[] = [];
  // Routes the fallback found but cannot name. They are kept apart rather than dropped, so the
  // planner can report each one as a gap when it would otherwise have been scanned.
  const unusable: UnusableRoute[] = [];

  const collect = (url: string): void => {
    if (urlsSeen.has(url)) return;
    urlsSeen.add(url);
    const derived = deriveScreenId(url);
    if (!derived.ok) {
      unusable.push({ url, reason: `the screen id derived from this route path ${derived.problem}` });
      return;
    }
    routes.push({ screenId: derived.screenId, url, entryFile: null });
  };

  for (const match of rawRouter.matchAll(attributeRe)) {
    const [, url] = match;
    if (typeof url === 'string') collect(url);
  }

  for (const match of rawRouter.matchAll(objectRe)) {
    const [, url] = match;
    if (typeof url === 'string') collect(url);
  }

  return { routes, unusable };
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
  for (const pathMatch of region.matchAll(/path:\s*['"`](\/[^'"`]*)['"`]/g)) {
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
