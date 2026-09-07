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

/**
 * One route literal found in router source.
 *
 * `offset` is the index in the router source of the `path` literal that declared the route, so a
 * caller that has to name the route can report the declaration rather than the first place the
 * same text happens to appear. Comments are blanked before matching, so a commented-out route is
 * neither reported as a route nor mistaken for the declaration of a real one. What the offset does
 * not promise is that the declaration is live code in every other sense: a route inside a branch
 * that never runs is still a declaration here.
 */
export interface ParsedRouteSite {
  path: string;
  component: string | null;
  offset: number;
}

/** A route whose path cannot be turned into a screen id, with the reason in config-message words. */
export interface UnusableRoute {
  url: string;
  reason: string;
}

/**
 * Returns the index just past the string literal that starts at `start`.
 *
 * A backslash escapes the next character. An unterminated literal ends at the newline rather than
 * running to the end of the file, so one stray quote costs one line and not the whole source.
 */
export function skipStringLiteral(raw: string, start: number): number {
  const quote = raw[start];
  let index = start + 1;
  while (index < raw.length) {
    const character = raw[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) {
      return index + 1;
    }
    if (character === '\n' && quote !== '`') {
      return index;
    }
    index += 1;
  }
  return raw.length;
}

/**
 * Returns the source with every comment replaced by spaces, the same length and the same newlines.
 *
 * A commented-out route is not a route. The parsers here match raw text, so without this a
 * commented declaration is found before the real one, and the duplicate rule then keeps the
 * comment and discards the route that actually exists. The replacement keeps every offset and
 * every line break where it was, so an offset taken from the blanked text names the same
 * character in the file.
 *
 * String literals are stepped over so a `//` inside a URL, or a `/*` inside any other string, does
 * not start a comment. A backslash escapes the next character, which is what keeps an escaped
 * slash in a regular expression literal from reading as a comment. The one case this does not
 * reach is a comment written inside a `${}` expression in a template literal, which is left alone.
 */
export function blankComments(raw: string): string {
  const out = raw.split('');
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== '\n') {
        out[index] = ' ';
      }
    }
  };

  let index = 0;
  while (index < raw.length) {
    const character = raw[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '/' && raw[index + 1] === '/') {
      const newline = raw.indexOf('\n', index);
      const end = newline < 0 ? raw.length : newline;
      blank(index, end);
      index = end;
      continue;
    }
    if (character === '/' && raw[index + 1] === '*') {
      const close = raw.indexOf('*/', index + 2);
      const end = close < 0 ? raw.length : close + 2;
      blank(index, end);
      index = end;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      index = skipStringLiteral(raw, index);
      continue;
    }
    index += 1;
  }

  return out.join('');
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
  // A commented-out route is not a route, and scanning it would put a screen in the plan that the
  // application never serves.
  const source = blankComments(rawRouter);
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

  for (const match of source.matchAll(attributeRe)) {
    const [, url] = match;
    if (typeof url === 'string') collect(url);
  }

  for (const match of source.matchAll(objectRe)) {
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
export function parseDataRouterRoutes(raw: string): ParsedRouteSite[] {
  // Comments are blanked before anything is matched. A commented-out entry would otherwise be
  // found first and kept by the duplicate rule, discarding the route that actually exists, and a
  // stray parenthesis in a comment would move the end of the call argument. The blanked text is
  // the same length with the same line breaks, so every offset below still points at the same
  // character in the file.
  const region = extractRouterCallArg(blankComments(raw));
  if (region === null) {
    return [];
  }
  const routes: ParsedRouteSite[] = [];
  const seen = new Set<string>();
  for (const pathMatch of region.text.matchAll(/path:\s*['"`](\/[^'"`]*)['"`]/g)) {
    const routePath = pathMatch[1];
    if (typeof routePath !== 'string' || pathMatch.index === undefined || seen.has(routePath)) {
      continue;
    }
    seen.add(routePath);
    // The match starts at `path:`, so the offset points at the declaration in the file, not at
    // some earlier line that happens to contain the same path text.
    routes.push({ path: routePath, component: null, offset: region.start + pathMatch.index });
  }
  return routes;
}

// Returns the balanced-paren argument of the first create*Router(...) call and where it starts in
// the source, or null. The start index is what lets a caller turn an offset inside the region back
// into an offset in the whole file.
function extractRouterCallArg(raw: string): { text: string; start: number } | null {
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
        return { text: raw.slice(start, i + 1), start };
      }
    }
  }
  return null;
}

export function mergeParsedRoutes(
  jsxRoutes: readonly ParsedRouteSite[],
  dataRoutes: readonly ParsedRouteSite[],
): ParsedRouteSite[] {
  const byPath = new Map<string, ParsedRouteSite>();
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
