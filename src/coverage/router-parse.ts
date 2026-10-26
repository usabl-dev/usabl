/**
 * Shared router source parsing for route manifest discovery and init.
 *
 * The router file is parsed, and routes are read only from the real router. That is the route
 * tree under a `<Routes>` or `<Switch>` element; the first argument of a call to
 * `createBrowserRouter`, `createHashRouter`, or `createMemoryRouter` (or a local name for one of
 * them: an import alias, a const that holds one, or a const made by a wrapper call that takes
 * one); the argument of `useRoutes`; and the JSX passed to `createRoutesFromElements` or
 * `createRoutesFromChildren`. Strings, comments, and regular expressions are not code in the
 * syntax tree, so a commented-out route, a stray delimiter in a string, or a router call written in
 * a string is never read as part of the router.
 *
 * Nothing route-shaped is dropped in silence. A `<Route>` outside every router that was read, a
 * call whose name ends in "Router" that is not a known factory, a wrapper call that cannot be
 * followed, and a route list changed in place are each an `unreadable` entry with a line. A file
 * with `<Route>` elements or `path:` objects but no router is one entry for the file, and none of
 * its routes are read, because nothing shows which of them are real.
 *
 * A route path is read when it is a string, a template with no expressions, or a reference to a
 * `const` in the same module whose value is one of those, including a member of a const object
 * such as `ROUTES.home`. A route the reader finds but cannot resolve comes back in `unreadable`
 * with its line, so the planner, init, and drift can each say so. A file that does not parse comes
 * back the same way, as one unreadable entry, never as a router with no routes.
 *
 * It must never invent entry files. A component is attributed only to a JSX route that has no child
 * routes and that sits in a router this module defines, including JSX passed to
 * `createRoutesFromElements`. Route objects are never attributed.
 */
import { createHash } from 'node:crypto';
import { describeIdProblem } from '../intake/id-grammar.js';
import { child, children, lineOf, parseSource, syntaxForFile, walk, type AstNode } from '../primitives/source-ast.js';

export interface ParsedRoutePath {
  screenId: string;
  url: string;
  entryFile: null;
}

/**
 * One route read from router source.
 *
 * `offset` is the index in the router source of the `path` attribute or property the route was
 * read from (or of the route itself, for an index route), so a caller that has to name the route
 * reports that declaration rather than the first place the same text happens to appear.
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
 * A route the reader found but could not read, or a file it could not parse.
 *
 * `line` is the one-based line of the route expression, or of the syntax error. The reason is a
 * full sentence that never repeats source text.
 */
export interface UnreadableRoute {
  line: number | null;
  reason: string;
  // True when the gap is about the whole file: it does not parse, or it has route paths but no
  // router. The line, when there is one, is where the syntax error is.
  wholeFile?: true;
  // A short hash of the declaration's source text and the reason, for one route declaration. It
  // stays the same when other lines move, and changes when the declaration itself changes, so
  // usabl.routes.json can acknowledge this entry by id. A whole-file gap has none: a file that does
  // not parse, or has no router, is never acknowledged.
  id?: string;
}

export interface RouterSourceRead {
  routes: ParsedRouteSite[];
  // Routes read from create*Router(...) arguments only, which init and its tests still read alone.
  dataRoutes: ParsedRouteSite[];
  unreadable: UnreadableRoute[];
  // Whether the module calls create*Router(...).
  dataRouter: boolean;
  // Local names bound by relative, non-type imports, mapped to their specifiers.
  localImports: Map<string, string>;
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

export function parseRouterFallback(
  rawRouter: string,
  file = 'router.tsx',
): { routes: ParsedRoutePath[]; unusable: UnusableRoute[]; unreadable: UnreadableRoute[] } {
  const read = readRouterSource(rawRouter, file);
  const urlsSeen = new Set<string>();
  const routes: ParsedRoutePath[] = [];
  // Routes the reader found but cannot name. They are kept apart rather than dropped, so the
  // planner can report each one as a gap when it would otherwise have been scanned.
  const unusable: UnusableRoute[] = [];
  for (const route of read.routes) {
    if (urlsSeen.has(route.path)) continue;
    urlsSeen.add(route.path);
    const derived = deriveScreenId(route.path);
    if (!derived.ok) {
      unusable.push({ url: route.path, reason: `the screen id derived from this route path ${derived.problem}` });
      continue;
    }
    routes.push({ screenId: derived.screenId, url: route.path, entryFile: null });
  }
  return { routes, unusable, unreadable: read.unreadable };
}

export function isRouterSource(raw: string): boolean {
  return (
    raw.includes('<Route') ||
    raw.includes('path=') ||
    raw.includes('createBrowserRouter') ||
    /path:\s*['"`]/.test(raw)
  );
}

// Discovers data-router route URLs from the create*Router(...) argument only. It never attributes
// a component: a data route's element is not proof of which file renders the screen, and
// route-manifest's rule holds here too, never invent entry-file attribution from router text.
export function parseDataRouterRoutes(raw: string, file = 'router.tsx'): ParsedRouteSite[] {
  return readRouterSource(raw, file).dataRoutes;
}

/**
 * Merges JSX routes and data routes into one entry per path, JSX routes first.
 *
 * A path keeps a component only when exactly one distinct component was read for it. Two
 * different components for one path is a conflict this reader cannot settle, so attribution is
 * left null rather than given to whichever came last.
 */
export function mergeParsedRoutes(
  jsxRoutes: readonly ParsedRouteSite[],
  dataRoutes: readonly ParsedRouteSite[],
): ParsedRouteSite[] {
  const byPath = new Map<string, { site: ParsedRouteSite; components: Set<string> }>();
  for (const route of [...jsxRoutes, ...dataRoutes]) {
    const entry = byPath.get(route.path) ?? { site: route, components: new Set<string>() };
    if (route.component !== null) entry.components.add(route.component);
    byPath.set(route.path, entry);
  }
  return [...byPath.values()].map(({ site, components }) => ({
    ...site,
    component: components.size === 1 ? ([...components][0] ?? null) : null,
  }));
}

// The calls whose first argument is the application's route list. A local name imported as one of
// these, a const that holds one, and a const made by a call that takes one (a wrapper such as an
// error reporter's) count as the same function.
const DATA_ROUTER_FUNCTIONS = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter']);
// The hook whose argument is a route list, read like a <Routes> element.
const ROUTES_HOOK = 'useRoutes';
// Array methods that change the array they are called on.
const MUTATING_METHODS = new Set(['push', 'unshift', 'splice', 'pop', 'shift', 'fill', 'copyWithin']);
// The calls that turn a JSX route tree into a route list.
const ROUTES_FROM_ELEMENTS_FUNCTIONS = new Set(['createRoutesFromElements', 'createRoutesFromChildren']);
// The JSX elements whose children are the route tree.
const JSX_ROUTER_ELEMENTS = new Set(['Routes', 'Switch']);
// Elements that may sit among routes and declare no screen of their own.
const NON_ROUTE_ELEMENTS = new Set(['Navigate', 'Redirect']);
// Wrappers that the parser keeps around an expression and that do not change its value.
const TRANSPARENT_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
  'ParenthesizedExpression',
]);

const REASONS = {
  unresolvedPath:
    'usabl could not resolve this route path. It reads a string, a template with no expressions, or a const in the same module that holds one.',
  noPathValue: 'This route has a path attribute with no value, so usabl cannot tell its path.',
  spreadRoute: 'This route takes its props from a spread or a computed key, so usabl cannot tell its path or its child routes.',
  computedRoutes: 'These routes are built by code, for example with map or a function call, so usabl cannot list them.',
  nonRouteChild: 'This element sits among the routes but is not a <Route>, so usabl cannot tell which routes it adds.',
  unknownParent: "This route path is relative, and usabl could not read its parent route's path, so it cannot tell the full path.",
  ambiguousBase:
    'This route path is relative, and this file has more than one router, so usabl cannot tell which path it is relative to.',
  strayRelative: 'This route path is relative, and no router in this file owns the route, so usabl cannot tell the full path.',
  splat:
    'This route path ends in "*", so it matches many URLs and usually mounts routes declared somewhere else. usabl cannot list the screens under it.',
  looseRoute:
    'This <Route> is not inside a router usabl reads, so usabl does not scan it. It may still be a real route, for example one rendered beside a <Switch>.',
  mutatedList:
    'This route list is changed elsewhere in the file, for example with push or an index assignment, so usabl cannot tell which routes it holds.',
  unknownFactory:
    'This call looks like it creates a router, but usabl does not know the function, so it does not read the routes it creates.',
  wrappedFactory: 'This call wraps a router factory in a way usabl cannot follow, so it does not read the routes it creates.',
  noRouter:
    'This file has route paths but no router usabl reads (createBrowserRouter, createHashRouter, createMemoryRouter, createRoutesFromElements, createRoutesFromChildren, useRoutes, <Routes>, or <Switch>), so usabl cannot tell which of them are real and reads none.',
} as const;

function nameOf(node: AstNode | null): string | null {
  return node !== null && typeof node['name'] === 'string' ? node['name'] : null;
}

function stringValue(node: AstNode | null): string | null {
  return node !== null && node.type === 'StringLiteral' && typeof node['value'] === 'string' ? node['value'] : null;
}

function unwrap(node: AstNode | null): AstNode | null {
  let current = node;
  while (current !== null && TRANSPARENT_WRAPPERS.has(current.type)) {
    current = child(current, 'expression');
  }
  return current;
}

function calleeName(call: AstNode): string | null {
  const callee = unwrap(child(call, 'callee'));
  if (callee === null) return null;
  if (callee.type === 'Identifier') return nameOf(callee);
  if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && callee['computed'] !== true) {
    return nameOf(child(callee, 'property'));
  }
  return null;
}

function jsxElementName(element: AstNode): string | null {
  const name = child(child(element, 'openingElement') ?? element, 'name');
  if (name === null) return null;
  if (name.type === 'JSXIdentifier') return nameOf(name);
  if (name.type === 'JSXMemberExpression') return nameOf(child(name, 'property'));
  return null;
}

// The identifier names a binding pattern introduces, such as the names in `const { a, b: [c] } = x`.
function patternNames(pattern: AstNode | null, into: string[]): void {
  if (pattern === null) return;
  switch (pattern.type) {
    case 'Identifier': {
      const name = nameOf(pattern);
      if (name !== null) into.push(name);
      return;
    }
    case 'ObjectPattern':
      for (const property of children(pattern, 'properties')) {
        patternNames(property.type === 'RestElement' ? child(property, 'argument') : child(property, 'value'), into);
      }
      return;
    case 'ArrayPattern':
      for (const element of children(pattern, 'elements')) patternNames(element, into);
      return;
    case 'AssignmentPattern':
      patternNames(child(pattern, 'left'), into);
      return;
    case 'RestElement':
      patternNames(child(pattern, 'argument'), into);
      return;
    case 'TSParameterProperty':
      patternNames(child(pattern, 'parameter'), into);
      return;
    default:
      return;
  }
}

function memberRoot(node: AstNode | null): string | null {
  let current = unwrap(node);
  while (current !== null && (current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression')) {
    current = unwrap(child(current, 'object'));
  }
  return current?.type === 'Identifier' ? nameOf(current) : null;
}

/**
 * What the module binds, read once so a reference can be resolved to its declaration.
 *
 * A name resolves only when the module binds it exactly once and that binding is a `const` with an
 * initializer. A name bound twice, for example a module const shadowed by a parameter, is not
 * resolved, because telling which binding a reference means needs scope analysis this reader does
 * not do. An object or array that is changed anywhere in the module, by assigning or deleting a
 * property or an index, or by calling push, unshift, splice, pop, shift, fill, or copyWithin on
 * it, is not read either.
 */
class ModuleBindings {
  private readonly counts = new Map<string, number>();
  private readonly consts = new Map<string, AstNode>();
  private readonly mutated = new Set<string>();
  // Local import names mapped to the name they were imported as, such as makeRouter to
  // createBrowserRouter in `import { createBrowserRouter as makeRouter }`.
  readonly importedAs = new Map<string, string>();
  // Every const name with its initializer, for following aliases of a router factory.
  readonly constEntries: Array<[string, AstNode]> = [];

  constructor(program: AstNode) {
    walk(program, (node, ancestors) => {
      const names: string[] = [];
      switch (node.type) {
        case 'VariableDeclarator': {
          const id = child(node, 'id');
          patternNames(id, names);
          const declaration = ancestors[ancestors.length - 1];
          const init = child(node, 'init');
          const name = id?.type === 'Identifier' ? nameOf(id) : null;
          if (declaration?.['kind'] === 'const' && name !== null && init !== null) {
            this.consts.set(name, init);
            this.constEntries.push([name, init]);
          }
          break;
        }
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
        case 'ObjectMethod':
        case 'ClassMethod':
        case 'ClassPrivateMethod':
          patternNames(child(node, 'id'), names);
          for (const param of children(node, 'params')) patternNames(param, names);
          break;
        case 'ClassDeclaration':
        case 'ClassExpression':
        case 'TSEnumDeclaration':
        case 'TSModuleDeclaration':
        case 'TSImportEqualsDeclaration':
          patternNames(child(node, 'id'), names);
          break;
        case 'ImportSpecifier': {
          patternNames(child(node, 'local'), names);
          const local = nameOf(child(node, 'local'));
          const imported = child(node, 'imported');
          const importedName = nameOf(imported) ?? stringValue(imported);
          if (local !== null && importedName !== null) this.importedAs.set(local, importedName);
          break;
        }
        case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
          patternNames(child(node, 'local'), names);
          break;
        case 'CallExpression': {
          // routes.push(...), routes.splice(...), and the like change the array in place.
          const callee = unwrap(child(node, 'callee'));
          if (
            (callee?.type === 'MemberExpression' || callee?.type === 'OptionalMemberExpression') &&
            callee['computed'] !== true &&
            MUTATING_METHODS.has(nameOf(child(callee, 'property')) ?? '')
          ) {
            const root = memberRoot(child(callee, 'object'));
            if (root !== null) this.mutated.add(root);
          }
          break;
        }
        case 'CatchClause':
          patternNames(child(node, 'param'), names);
          break;
        case 'AssignmentExpression': {
          const root = memberRoot(child(node, 'left'));
          if (root !== null && child(node, 'left')?.type !== 'Identifier') this.mutated.add(root);
          break;
        }
        case 'UpdateExpression':
        case 'UnaryExpression': {
          const argument = child(node, 'argument');
          const mutates = node.type === 'UpdateExpression' || node['operator'] === 'delete';
          const root = mutates && argument?.type !== 'Identifier' ? memberRoot(argument) : null;
          if (root !== null) this.mutated.add(root);
          break;
        }
        default:
          break;
      }
      for (const name of names) this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    });
  }

  constInit(name: string): AstNode | null {
    if (this.counts.get(name) !== 1) return null;
    return this.consts.get(name) ?? null;
  }

  isMutated(name: string): boolean {
    return this.mutated.has(name);
  }
}

class RouterReader {
  readonly jsxSites: ParsedRouteSite[] = [];
  readonly dataSites: ParsedRouteSite[] = [];
  // Each gap keeps the offset of the expression it is about, so two gaps on one line stay two.
  readonly unreadable: Array<UnreadableRoute & { offset: number }> = [];
  // Expressions already being followed, so a const that refers to itself cannot loop.
  private readonly following = new Set<AstNode>();
  // Nodes reported as unreadable, so a <Route> inside one is not reported a second time.
  readonly gapped = new Set<AstNode>();
  // <Route> elements this reader read as part of a router.
  readonly visitedRoutes = new Set<AstNode>();

  constructor(
    private readonly bindings: ModuleBindings,
    private readonly raw: string,
  ) {}

  gap(node: AstNode, reason: string): void {
    const start = typeof node.start === 'number' ? node.start : 0;
    const end = typeof node.end === 'number' ? node.end : start;
    // Whitespace is collapsed so reformatting the declaration keeps its id.
    const text = this.raw.slice(start, end).replace(/\s+/g, ' ').trim();
    const id = createHash('sha256').update(`${reason}\u0000${text}`).digest('hex').slice(0, 12);
    this.gapped.add(node);
    this.unreadable.push({ line: lineOf(node), reason, id, offset: start });
  }

  // The initializer of a const route list or route tree, or null with a gap when the list is
  // changed somewhere in the module and so cannot be read as written.
  private followList(node: AstNode): AstNode | null {
    const name = nameOf(node);
    const init = name === null ? null : this.bindings.constInit(name);
    if (init === null || this.following.has(init)) return null;
    if (name !== null && this.bindings.isMutated(name)) {
      this.gap(node, REASONS.mutatedList);
      // The routes written in the list are covered by this one entry.
      this.gapped.add(init);
      return null;
    }
    return init;
  }

  // Resolves an expression to the const value it names, following identifiers and members.
  private resolveValue(expression: AstNode | null): AstNode | null {
    const node = unwrap(expression);
    if (node === null) return null;
    if (node.type === 'Identifier') {
      const name = nameOf(node);
      const init = name === null ? null : this.bindings.constInit(name);
      if (init === null || this.following.has(init)) return null;
      this.following.add(init);
      try {
        return this.resolveValue(init);
      } finally {
        this.following.delete(init);
      }
    }
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const root = memberRoot(node);
      if (root === null || this.bindings.isMutated(root)) return null;
      const key = this.memberKey(node);
      const object = this.resolveObject(child(node, 'object'));
      if (key === null || object === null) return null;
      return this.resolveValue(this.propertyValue(object, key));
    }
    return node;
  }

  private memberKey(member: AstNode): string | null {
    const property = child(member, 'property');
    if (member['computed'] !== true) return property?.type === 'Identifier' ? nameOf(property) : null;
    return this.templateOrString(property);
  }

  private templateOrString(node: AstNode | null): string | null {
    const value = unwrap(node);
    if (value === null) return null;
    const literal = stringValue(value);
    if (literal !== null) return literal;
    if (value.type === 'TemplateLiteral' && children(value, 'expressions').length === 0) {
      const quasis = children(value, 'quasis');
      const cooked = quasis.length === 1 ? quasis[0]?.['value'] : null;
      if (typeof cooked === 'object' && cooked !== null) {
        const text = (cooked as Record<string, unknown>)['cooked'];
        return typeof text === 'string' ? text : null;
      }
    }
    return null;
  }

  private resolveObject(expression: AstNode | null): AstNode | null {
    const node = this.resolveValue(expression);
    if (node === null) return null;
    if (node.type === 'ObjectExpression') return node;
    // Object.freeze returns the object it is given.
    if (node.type === 'CallExpression' && calleeName(node) === 'freeze') {
      const args = children(node, 'arguments');
      return args.length === 1 ? this.resolveObject(args[0] ?? null) : null;
    }
    return null;
  }

  // The value stored under `key` in an object literal, or null when the literal cannot say for
  // sure: a spread, a computed key, or a method could also supply that key.
  private propertyValue(object: AstNode, key: string): AstNode | null {
    let value: AstNode | null = null;
    for (const property of children(object, 'properties')) {
      if (property.type !== 'ObjectProperty' || (property['computed'] === true && this.templateOrString(child(property, 'key')) === null)) {
        return null;
      }
      const propertyKey = child(property, 'key');
      const name = property['computed'] === true ? this.templateOrString(propertyKey) : (nameOf(propertyKey) ?? stringValue(propertyKey));
      if (name === key) value = child(property, 'value');
    }
    return value;
  }

  // A route path as a string, or null when it is not one this reader can resolve.
  resolvePath(expression: AstNode | null): string | null {
    return this.templateOrString(this.resolveValue(expression));
  }

  // A path that ends in a `*` segment matches many URLs. A bare `*` is the catch-all page, which
  // is not a screen and is skipped. Any other, such as `/app/*`, usually mounts routes declared
  // somewhere this reader does not look, so it is a gap rather than a scan of a literal "*" URL.
  private isScreenPath(own: string, at: AstNode): boolean {
    if (lastSegment(own) !== '*') return true;
    if (own !== '*') this.gap(at, REASONS.splat);
    return false;
  }

  private joinPath(
    parent: string | null | undefined,
    own: string,
    base: string | null,
    at: AstNode,
    stray: boolean,
  ): string | null {
    if (own.startsWith('/')) return own;
    if (parent === undefined) {
      this.gap(at, REASONS.unknownParent);
      return null;
    }
    const prefix = parent ?? base;
    if (prefix === null) {
      this.gap(at, stray ? REASONS.strayRelative : REASONS.ambiguousBase);
      return null;
    }
    if (own === '') return prefix;
    return prefix.endsWith('/') ? `${prefix}${own}` : `${prefix}/${own}`;
  }

  /**
   * Reads JSX route children. `parent` is the nearest ancestor route's full path: null at the top
   * of the router, and undefined when that path could not be read. `base` is what a top-level
   * relative path is relative to, or null when this reader cannot tell.
   */
  readJsxChildren(
    nodes: readonly AstNode[],
    parent: string | null | undefined,
    base: string | null,
    attribute: boolean,
    strayReason = false,
  ): void {
    for (const node of nodes) {
      this.readJsxChild(node, parent, base, attribute, strayReason);
    }
  }

  private readJsxChild(
    node: AstNode,
    parent: string | null | undefined,
    base: string | null,
    attribute: boolean,
    strayReason: boolean,
  ): void {
    switch (node.type) {
      case 'JSXText':
        return;
      case 'JSXFragment':
        this.readJsxChildren(children(node, 'children'), parent, base, attribute, strayReason);
        return;
      case 'JSXExpressionContainer':
        this.readJsxExpression(child(node, 'expression'), parent, base, attribute, strayReason);
        return;
      case 'JSXElement': {
        const name = jsxElementName(node);
        if (name === 'Route') {
          this.readJsxRoute(node, parent, base, attribute, strayReason);
        } else if (name === 'Fragment') {
          this.readJsxChildren(children(node, 'children'), parent, base, attribute, strayReason);
        } else if (name === null || !NON_ROUTE_ELEMENTS.has(name)) {
          this.gap(node, REASONS.nonRouteChild);
        }
        return;
      }
      default:
        this.gap(node, REASONS.computedRoutes);
    }
  }

  private readJsxExpression(
    expression: AstNode | null,
    parent: string | null | undefined,
    base: string | null,
    attribute: boolean,
    strayReason: boolean,
  ): void {
    const node = unwrap(expression);
    if (node === null || node.type === 'JSXEmptyExpression' || node.type === 'NullLiteral' || node.type === 'BooleanLiteral') {
      return;
    }
    if (node.type === 'Identifier' && nameOf(node) === 'undefined') return;
    switch (node.type) {
      case 'JSXElement':
      case 'JSXFragment':
        this.readJsxChild(node, parent, base, attribute, strayReason);
        return;
      case 'LogicalExpression':
        // `ready && <Route />` renders only its right side. `a || b` and `a ?? b` can render either.
        if (node['operator'] !== '&&') {
          this.readJsxExpression(child(node, 'left'), parent, base, attribute, strayReason);
        }
        this.readJsxExpression(child(node, 'right'), parent, base, attribute, strayReason);
        return;
      case 'ConditionalExpression':
        this.readJsxExpression(child(node, 'consequent'), parent, base, attribute, strayReason);
        this.readJsxExpression(child(node, 'alternate'), parent, base, attribute, strayReason);
        return;
      case 'ArrayExpression':
        for (const element of children(node, 'elements')) {
          this.readJsxExpression(element, parent, base, attribute, strayReason);
        }
        return;
      case 'Identifier': {
        const mutated = this.gapped.size;
        const init = this.followList(node);
        if (init === null) {
          if (this.gapped.size === mutated) this.gap(node, REASONS.computedRoutes);
          return;
        }
        this.following.add(init);
        try {
          this.readJsxExpression(init, parent, base, attribute, strayReason);
        } finally {
          this.following.delete(init);
        }
        return;
      }
      default:
        this.gap(node, REASONS.computedRoutes);
    }
  }

  private readJsxRoute(
    element: AstNode,
    parent: string | null | undefined,
    base: string | null,
    attribute: boolean,
    strayReason: boolean,
  ): void {
    this.visitedRoutes.add(element);
    const opening = child(element, 'openingElement');
    const attributes = opening === null ? [] : children(opening, 'attributes');
    let pathAttribute: AstNode | null = null;
    let spreadAfterPath = false;
    let isIndex = false;
    let elementValue: AstNode | null = null;
    for (const attr of attributes) {
      if (attr.type === 'JSXSpreadAttribute') {
        spreadAfterPath = true;
        continue;
      }
      const name = nameOf(child(attr, 'name'));
      if (name === 'path') {
        pathAttribute = attr;
        spreadAfterPath = false;
      } else if (name === 'index') {
        const value = child(attr, 'value');
        const expression = value?.type === 'JSXExpressionContainer' ? unwrap(child(value, 'expression')) : null;
        isIndex = value === null || (expression?.type === 'BooleanLiteral' && expression['value'] === true);
      } else if (name === 'element') {
        elementValue = child(attr, 'value');
      }
    }
    const routeChildren = children(element, 'children');
    // Whitespace and comments are not child routes.
    const hasChildRoutes = routeChildren.some((node) => {
      if (node.type === 'JSXText') return String(node['value'] ?? '').trim() !== '';
      return !(node.type === 'JSXExpressionContainer' && child(node, 'expression')?.type === 'JSXEmptyExpression');
    });

    // A spread can supply the path, or replace one written before it.
    if (spreadAfterPath) {
      this.gap(element, REASONS.spreadRoute);
      this.readJsxChildren(routeChildren, undefined, base, attribute, strayReason);
      return;
    }

    let full: string | null | undefined = parent;
    let offsetNode: AstNode = element;
    if (pathAttribute !== null) {
      offsetNode = pathAttribute;
      const value = child(pathAttribute, 'value');
      const own =
        value === null
          ? null
          : value.type === 'JSXExpressionContainer'
            ? this.resolvePath(child(value, 'expression'))
            : stringValue(value);
      if (own === null) {
        this.gap(pathAttribute, value === null ? REASONS.noPathValue : REASONS.unresolvedPath);
        this.readJsxChildren(routeChildren, undefined, base, attribute, strayReason);
        return;
      }
      const joined = this.joinPath(parent, own, base, pathAttribute, strayReason);
      if (joined === null) {
        this.readJsxChildren(routeChildren, undefined, base, attribute, strayReason);
        return;
      }
      full = joined;
      if (this.isScreenPath(own, pathAttribute)) {
        this.jsxSites.push({
          path: joined,
          component: attribute && !hasChildRoutes ? elementComponent(elementValue) : null,
          offset: typeof pathAttribute.start === 'number' ? pathAttribute.start : 0,
        });
      }
    } else if (isIndex) {
      const indexPath = parent === undefined ? undefined : (parent ?? base);
      if (indexPath === undefined || indexPath === null) {
        this.gap(element, parent === undefined ? REASONS.unknownParent : strayReason ? REASONS.strayRelative : REASONS.ambiguousBase);
        return;
      }
      this.jsxSites.push({
        path: indexPath,
        component: attribute ? elementComponent(elementValue) : null,
        offset: typeof offsetNode.start === 'number' ? offsetNode.start : 0,
      });
      return;
    }
    // A pathless layout route passes its parent's path on to its children.
    this.readJsxChildren(routeChildren, full, base, attribute, strayReason);
  }

  /**
   * Reads a data router route list: an array literal, or a const that holds one. `base` is what a
   * top-level relative path is relative to: "/" for a create*Router call, and for useRoutes only
   * when it is the one router in the file.
   */
  readDataRoutes(expression: AstNode | null, parent: string | null | undefined, at: AstNode, base: string | null): void {
    const node = unwrap(expression);
    if (node === null) {
      this.gap(at, REASONS.computedRoutes);
      return;
    }
    if (node.type === 'ArrayExpression') {
      for (const element of children(node, 'elements')) {
        if (element.type === 'SpreadElement') {
          this.readDataRoutes(child(element, 'argument'), parent, element, base);
        } else {
          this.readDataEntry(element, parent, base);
        }
      }
      return;
    }
    if (node.type === 'CallExpression' && ROUTES_FROM_ELEMENTS_FUNCTIONS.has(calleeName(node) ?? '')) {
      // createRoutesFromElements(<Route ... />) is read as a JSX route tree with the router's base.
      this.readJsxChildren(children(node, 'arguments'), parent, base, true);
      return;
    }
    if (node.type === 'Identifier') {
      const gapsBefore = this.gapped.size;
      const init = this.followList(node);
      if (init !== null) {
        this.following.add(init);
        try {
          this.readDataRoutes(init, parent, node, base);
        } finally {
          this.following.delete(init);
        }
        return;
      }
      if (this.gapped.size !== gapsBefore) return;
    }
    this.gap(node, REASONS.computedRoutes);
  }

  private readDataEntry(entry: AstNode, parent: string | null | undefined, base: string | null): void {
    const node = unwrap(entry);
    if (node === null) return;
    if (node.type === 'Identifier') {
      const gapsBefore = this.gapped.size;
      const init = this.followList(node);
      if (init !== null) {
        this.following.add(init);
        try {
          this.readDataEntry(init, parent, base);
        } finally {
          this.following.delete(init);
        }
        return;
      }
      if (this.gapped.size !== gapsBefore) return;
    }
    if (node.type !== 'ObjectExpression') {
      this.gap(node, REASONS.computedRoutes);
      return;
    }
    let pathProperty: AstNode | null = null;
    let indexTrue = false;
    let childList: AstNode | null = null;
    // Where the last spread, the path, and the child routes sit among the properties. A later
    // property replaces an earlier one, so a spread can only supply what is written before it or
    // not written at all.
    let lastSpread = -1;
    let pathAt = -1;
    let childrenAt = -1;
    const properties = children(node, 'properties');
    for (let i = 0; i < properties.length; i += 1) {
      const property = properties[i];
      if (property === undefined) continue;
      if (property.type === 'SpreadElement') {
        lastSpread = i;
        continue;
      }
      const key = child(property, 'key');
      const keyName =
        property['computed'] === true ? this.templateOrString(key) : (nameOf(key) ?? stringValue(key));
      if (keyName === null) {
        // A computed key could be path or children.
        this.gap(node, REASONS.spreadRoute);
        return;
      }
      if (property.type === 'ObjectMethod') {
        // A method such as loader() or action() is not a path. A method or getter named path or
        // children could supply one, which this reader cannot evaluate.
        if (keyName === 'path' || keyName === 'children') {
          this.gap(node, REASONS.spreadRoute);
          return;
        }
        continue;
      }
      if (property.type !== 'ObjectProperty') continue;
      if (keyName === 'path') {
        pathProperty = property;
        pathAt = i;
      }
      if (keyName === 'index') {
        const value = unwrap(child(property, 'value'));
        indexTrue = value?.type === 'BooleanLiteral' && value['value'] === true;
      }
      if (keyName === 'children') {
        childList = child(property, 'value');
        childrenAt = i;
      }
    }
    if (lastSpread >= 0 && (pathAt < lastSpread || childrenAt < lastSpread)) {
      this.gap(node, REASONS.spreadRoute);
      return;
    }

    let full: string | null | undefined = parent;
    if (pathProperty !== null) {
      const own = this.resolvePath(child(pathProperty, 'value'));
      if (own === null) {
        this.gap(pathProperty, REASONS.unresolvedPath);
        full = undefined;
      } else {
        const joined = this.joinPath(parent, own, base, pathProperty, false);
        full = joined ?? undefined;
        if (joined !== null && this.isScreenPath(own, pathProperty)) {
          this.dataSites.push({
            path: joined,
            component: null,
            offset: typeof pathProperty.start === 'number' ? pathProperty.start : 0,
          });
        }
      }
    } else if (indexTrue) {
      const indexPath = parent === undefined ? undefined : (parent ?? base);
      if (indexPath === undefined || indexPath === null) {
        this.gap(node, parent === undefined ? REASONS.unknownParent : REASONS.ambiguousBase);
      } else {
        this.dataSites.push({ path: indexPath, component: null, offset: typeof node.start === 'number' ? node.start : 0 });
      }
    }
    if (childList !== null) {
      this.readDataRoutes(childList, full, node, base);
    }
  }
}

function lastSegment(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? '';
}

// The component named by `element={<Name />}`, when it is a plain identifier.
function elementComponent(value: AstNode | null): string | null {
  if (value?.type !== 'JSXExpressionContainer') return null;
  const expression = unwrap(child(value, 'expression'));
  if (expression?.type !== 'JSXElement') return null;
  const name = child(child(expression, 'openingElement') ?? expression, 'name');
  return name?.type === 'JSXIdentifier' ? nameOf(name) : null;
}

function readLocalImports(program: AstNode): Map<string, string> {
  // Only relative specifiers (starting with ".") can prove a local entry file. Package imports
  // are left unmapped so init cannot guess across dependencies. Type-only imports render nothing.
  const imports = new Map<string, string>();
  for (const statement of children(program, 'body')) {
    if (statement.type !== 'ImportDeclaration' || statement['importKind'] === 'type') continue;
    const specifier = stringValue(child(statement, 'source'));
    if (specifier === null || !specifier.startsWith('.')) continue;
    for (const binding of children(statement, 'specifiers')) {
      if (binding.type === 'ImportNamespaceSpecifier' || binding['importKind'] === 'type') continue;
      const local = nameOf(child(binding, 'local'));
      if (local !== null) imports.set(local, specifier);
    }
  }
  return imports;
}

// Every local name that refers to a known router factory: the factory names themselves, a name
// imported as one, a const that holds one, and a const made by a call that takes one, such as
// `const sentryCreateBrowserRouter = Sentry.wrapCreateBrowserRouterV6(createBrowserRouter)`.
function routerFactoryNames(bindings: ModuleBindings): Set<string> {
  const names = new Set(DATA_ROUTER_FUNCTIONS);
  for (const [local, imported] of bindings.importedAs) {
    if (DATA_ROUTER_FUNCTIONS.has(imported)) names.add(local);
  }
  const refersToFactory = (expression: AstNode | null): boolean => {
    const node = unwrap(expression);
    if (node?.type === 'Identifier') return names.has(nameOf(node) ?? '');
    if ((node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression') && node['computed'] !== true) {
      return DATA_ROUTER_FUNCTIONS.has(nameOf(child(node, 'property')) ?? '');
    }
    return false;
  };
  // Repeat until nothing new is found, so an alias of an alias is followed too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, init] of bindings.constEntries) {
      if (names.has(name) || bindings.constInit(name) === null) continue;
      const value = unwrap(init);
      const isAlias = refersToFactory(value);
      const isWrapper = value?.type === 'CallExpression' && children(value, 'arguments').some(refersToFactory);
      if (isAlias || isWrapper) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

/**
 * Reads the routes a router module declares.
 *
 * `file` decides the syntax: a `.ts` file is read without JSX, and a `.tsx` file with TypeScript.
 *
 * When the module defines a router, only that router is read. When it defines none, every
 * `<Route>` in the module is read as a URL with no attribution, because no router can be shown to
 * own it, and a relative path among them is unreadable.
 */
export function readRouterSource(raw: string, file = 'router.tsx'): RouterSourceRead {
  const parsed = parseSource(raw, syntaxForFile(file));
  if (!parsed.ok) {
    const where =
      parsed.line === null ? '' : ` at line ${parsed.line}${parsed.column === null ? '' : `, column ${parsed.column + 1}`}`;
    return {
      routes: [],
      dataRoutes: [],
      unreadable: [{ line: parsed.line, reason: `The file does not parse${where}, so usabl read no routes from it.`, wholeFile: true }],
      dataRouter: false,
      localImports: new Map(),
    };
  }
  const program = parsed.program;
  const bindings = new ModuleBindings(program);
  const reader = new RouterReader(bindings, raw);
  const factories = routerFactoryNames(bindings);
  const isFactoryReference = (expression: AstNode | null): boolean => {
    const node = unwrap(expression);
    if (node?.type === 'Identifier') return factories.has(nameOf(node) ?? '');
    if ((node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression') && node['computed'] !== true) {
      return DATA_ROUTER_FUNCTIONS.has(nameOf(child(node, 'property')) ?? '');
    }
    return false;
  };
  // A call that takes a router factory, such as wrap(createBrowserRouter), returns a router factory.
  const wrapsFactory = (call: AstNode): boolean => children(call, 'arguments').some(isFactoryReference);
  const isFactoryCall = (call: AstNode): boolean => {
    const callee = unwrap(child(call, 'callee'));
    if (callee === null) return false;
    if (callee.type === 'CallExpression') return wrapsFactory(callee);
    return isFactoryReference(callee);
  };

  const dataCalls: AstNode[] = [];
  const hookCalls: AstNode[] = [];
  const elementCalls: AstNode[] = [];
  const jsxRoots: AstNode[] = [];
  const allRoutes: Array<{ node: AstNode; ancestors: readonly AstNode[] }> = [];
  let hasPathObject = false;
  walk(program, (node, ancestors) => {
    if (node.type === 'CallExpression') {
      const name = calleeName(node);
      const parent = ancestors[ancestors.length - 1];
      if (isFactoryCall(node)) {
        dataCalls.push(node);
      } else if (name === ROUTES_HOOK) {
        hookCalls.push(node);
      } else if (name !== null && ROUTES_FROM_ELEMENTS_FUNCTIONS.has(name)) {
        // One passed straight to a router call is read with that call.
        const inside = ancestors.some((ancestor) => dataCalls.includes(ancestor) || hookCalls.includes(ancestor));
        if (!inside) elementCalls.push(node);
      } else if (wrapsFactory(node)) {
        // A wrapper that is stored in a const, or called right away, is followed. Any other use of
        // one cannot be followed, and is named so its routes are not lost in silence.
        const stored = parent?.type === 'VariableDeclarator' && child(parent, 'init') === node;
        const calledNow = parent?.type === 'CallExpression' && unwrap(child(parent, 'callee')) === node;
        if (!stored && !calledNow) reader.gap(node, REASONS.wrappedFactory);
      } else if (name !== null && name.endsWith('Router')) {
        reader.gap(node, REASONS.unknownFactory);
      }
    } else if (node.type === 'JSXElement') {
      const name = jsxElementName(node);
      if (name !== null && JSX_ROUTER_ELEMENTS.has(name)) jsxRoots.push(node);
      if (name === 'Route') allRoutes.push({ node, ancestors });
    } else if (node.type === 'ObjectProperty' && node['computed'] !== true) {
      const key = child(node, 'key');
      if ((nameOf(key) ?? stringValue(key)) === 'path') hasPathObject = true;
    }
  });

  for (const call of dataCalls) {
    reader.readDataRoutes(children(call, 'arguments')[0] ?? null, null, call, '/');
  }
  for (const call of elementCalls) {
    reader.readJsxChildren(children(call, 'arguments'), null, '/', true);
  }
  // A top-level relative path in a <Routes> element or a useRoutes call is relative to "/" only
  // when it is the one router in the file. Otherwise it may be a descendant router mounted under a
  // route somewhere else.
  const onlyRouter =
    jsxRoots.length + hookCalls.length === 1 && dataCalls.length === 0 && elementCalls.length === 0;
  for (const call of hookCalls) {
    reader.readDataRoutes(children(call, 'arguments')[0] ?? null, null, call, onlyRouter ? '/' : null);
  }
  for (const root of jsxRoots) {
    reader.readJsxChildren(children(root, 'children'), null, onlyRouter ? '/' : null, true);
  }
  const routerFound = dataCalls.length + hookCalls.length + elementCalls.length + jsxRoots.length > 0;
  if (routerFound) {
    // A <Route> that no router read owns is kept out of the scan, because it may be a decoy, and
    // named, because it may be real. One inside a node already named is not named again, and
    // neither is one nested in another unread <Route>.
    for (const { node, ancestors } of allRoutes) {
      if (reader.visitedRoutes.has(node)) continue;
      if (ancestors.some((ancestor) => reader.gapped.has(ancestor))) continue;
      if (ancestors.some((ancestor) => ancestor.type === 'JSXElement' && jsxElementName(ancestor) === 'Route' && !reader.visitedRoutes.has(ancestor))) {
        continue;
      }
      reader.gap(node, REASONS.looseRoute);
    }
  } else if (allRoutes.length > 0 || hasPathObject) {
    // No router, so no way to tell which routes are real. One gap for the file, and none read.
    return {
      routes: [],
      dataRoutes: [],
      unreadable: [{ line: null, reason: REASONS.noRouter, wholeFile: true }],
      dataRouter: false,
      localImports: readLocalImports(program),
    };
  }

  // Routes stay in the order the router declares them, which the syntax tree fixes for a given
  // file. One entry per gap: a route tree reached from two places reports each gap once.
  const seenGaps = new Set<string>();
  const unreadable: UnreadableRoute[] = [...reader.unreadable]
    .sort((a, b) => a.offset - b.offset)
    .filter((gap) => {
      const key = `${gap.offset}\u0000${gap.reason}`;
      if (seenGaps.has(key)) return false;
      seenGaps.add(key);
      return true;
    })
    .map(({ line, reason, id }) => (id === undefined ? { line, reason } : { line, reason, id }));
  return {
    routes: mergeParsedRoutes(reader.jsxSites, reader.dataSites),
    dataRoutes: mergeParsedRoutes([], reader.dataSites),
    unreadable,
    dataRouter: dataCalls.length > 0,
    localImports: readLocalImports(program),
  };
}
