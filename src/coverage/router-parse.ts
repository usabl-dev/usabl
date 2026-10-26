/**
 * Shared router source parsing for route manifest discovery and init.
 *
 * The router file is parsed, and routes are read only from the real router: the route tree under
 * a `<Routes>` or `<Switch>` element, the argument of a `create*Router(...)` call, or the JSX passed
 * to `createRoutesFromElements(...)`. Strings, comments, and regular expressions are not code in the
 * syntax tree, so a commented-out route, a stray delimiter in a string, or a router call written in
 * a string is never read as part of the router. A path object or a `<Route>` elsewhere in the
 * module is not part of the router either, and is not read when the module has one.
 *
 * A route path is read when it is a string, a template with no expressions, or a reference to a
 * `const` in the same module whose value is one of those, including a member of a const object
 * such as `ROUTES.home`. A route the reader finds but cannot resolve is never dropped: it comes
 * back in `unreadable` with its line, so the planner, init, and drift can each say so. A file that
 * does not parse comes back the same way, as one unreadable entry, never as a router with no routes.
 *
 * It must never invent entry files. A component is attributed only to a JSX route that has no child
 * routes and that sits in a router this module defines.
 */
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
  // True when the whole file could not be read because it does not parse. The line is then where
  // the syntax error is, and the gap is about the file, not about one route.
  wholeFile?: true;
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

// The calls whose first argument is the application's route list.
const DATA_ROUTER_FUNCTIONS = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter']);
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
 * not do. An object whose properties are assigned or deleted anywhere in the module is not read.
 */
class ModuleBindings {
  private readonly counts = new Map<string, number>();
  private readonly consts = new Map<string, AstNode>();
  private readonly mutated = new Set<string>();

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
        case 'ImportSpecifier':
        case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
          patternNames(child(node, 'local'), names);
          break;
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

  constructor(private readonly bindings: ModuleBindings) {}

  gap(node: AstNode, reason: string): void {
    this.unreadable.push({ line: lineOf(node), reason, offset: typeof node.start === 'number' ? node.start : 0 });
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
        const name = nameOf(node);
        const init = name === null ? null : this.bindings.constInit(name);
        if (init === null || this.following.has(init)) {
          this.gap(node, REASONS.computedRoutes);
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
      if (lastSegment(own) !== '*') {
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

  /** Reads a data router route list: an array literal, or a const that holds one. */
  readDataRoutes(expression: AstNode | null, parent: string | null | undefined, at: AstNode): void {
    const node = unwrap(expression);
    if (node === null) {
      this.gap(at, REASONS.computedRoutes);
      return;
    }
    if (node.type === 'ArrayExpression') {
      for (const element of children(node, 'elements')) {
        if (element.type === 'SpreadElement') {
          this.readDataRoutes(child(element, 'argument'), parent, element);
        } else {
          this.readDataEntry(element, parent);
        }
      }
      return;
    }
    if (node.type === 'CallExpression' && ROUTES_FROM_ELEMENTS_FUNCTIONS.has(calleeName(node) ?? '')) {
      // createRoutesFromElements(<Route ... />) is read as a JSX route tree with the router's base.
      this.readJsxChildren(children(node, 'arguments'), parent, '/', true);
      return;
    }
    if (node.type === 'Identifier') {
      const name = nameOf(node);
      const init = name === null ? null : this.bindings.constInit(name);
      if (init !== null && !this.following.has(init)) {
        this.following.add(init);
        try {
          this.readDataRoutes(init, parent, node);
        } finally {
          this.following.delete(init);
        }
        return;
      }
    }
    this.gap(node, REASONS.computedRoutes);
  }

  private readDataEntry(entry: AstNode, parent: string | null | undefined): void {
    const node = unwrap(entry);
    if (node === null) return;
    if (node.type === 'Identifier') {
      const name = nameOf(node);
      const init = name === null ? null : this.bindings.constInit(name);
      if (init !== null && !this.following.has(init)) {
        this.following.add(init);
        try {
          this.readDataEntry(init, parent);
        } finally {
          this.following.delete(init);
        }
        return;
      }
    }
    if (node.type !== 'ObjectExpression') {
      this.gap(node, REASONS.computedRoutes);
      return;
    }
    let pathProperty: AstNode | null = null;
    let indexTrue = false;
    let childList: AstNode | null = null;
    for (const property of children(node, 'properties')) {
      const key = property.type === 'ObjectProperty' ? child(property, 'key') : null;
      const keyName =
        property.type !== 'ObjectProperty'
          ? null
          : property['computed'] === true
            ? this.templateOrString(key)
            : (nameOf(key) ?? stringValue(key));
      if (keyName === null) {
        // A spread, a method, or a computed key could supply the path or the child routes.
        this.gap(node, REASONS.spreadRoute);
        return;
      }
      if (keyName === 'path') pathProperty = property;
      if (keyName === 'index') {
        const value = unwrap(child(property, 'value'));
        indexTrue = value?.type === 'BooleanLiteral' && value['value'] === true;
      }
      if (keyName === 'children') childList = child(property, 'value');
    }

    let full: string | null | undefined = parent;
    if (pathProperty !== null) {
      const own = this.resolvePath(child(pathProperty, 'value'));
      if (own === null) {
        this.gap(pathProperty, REASONS.unresolvedPath);
        full = undefined;
      } else {
        const joined = this.joinPath(parent, own, '/', pathProperty, false);
        full = joined ?? undefined;
        if (joined !== null && lastSegment(own) !== '*') {
          this.dataSites.push({
            path: joined,
            component: null,
            offset: typeof pathProperty.start === 'number' ? pathProperty.start : 0,
          });
        }
      }
    } else if (indexTrue) {
      if (parent === undefined) {
        this.gap(node, REASONS.unknownParent);
      } else {
        this.dataSites.push({ path: parent ?? '/', component: null, offset: typeof node.start === 'number' ? node.start : 0 });
      }
    }
    if (childList !== null) {
      this.readDataRoutes(childList, full, node);
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
  const reader = new RouterReader(new ModuleBindings(program));

  const dataCalls: AstNode[] = [];
  const elementCalls: AstNode[] = [];
  const jsxRoots: AstNode[] = [];
  const looseRoutes: AstNode[] = [];
  walk(program, (node, ancestors) => {
    if (node.type === 'CallExpression') {
      const name = calleeName(node);
      if (name !== null && DATA_ROUTER_FUNCTIONS.has(name)) dataCalls.push(node);
      if (name !== null && ROUTES_FROM_ELEMENTS_FUNCTIONS.has(name)) {
        // One passed straight to create*Router(...) is read with that call.
        const inside = ancestors.some((ancestor) => dataCalls.includes(ancestor));
        if (!inside) elementCalls.push(node);
      }
    } else if (node.type === 'JSXElement') {
      const name = jsxElementName(node);
      if (name !== null && JSX_ROUTER_ELEMENTS.has(name)) jsxRoots.push(node);
      if (name === 'Route' && !ancestors.some((ancestor) => ancestor.type === 'JSXElement' && jsxElementName(ancestor) === 'Route')) {
        looseRoutes.push(node);
      }
    }
  });

  for (const call of dataCalls) {
    reader.readDataRoutes(children(call, 'arguments')[0] ?? null, null, call);
  }
  for (const call of elementCalls) {
    reader.readJsxChildren(children(call, 'arguments'), null, '/', true);
  }
  // A top-level relative path in a <Routes> element is relative to "/" only when that element is
  // the one router in the file. Otherwise it may be a descendant router mounted under a route.
  const onlyRouter = jsxRoots.length === 1 && dataCalls.length === 0 && elementCalls.length === 0;
  for (const root of jsxRoots) {
    reader.readJsxChildren(children(root, 'children'), null, onlyRouter ? '/' : null, true);
  }
  const routerFound = dataCalls.length > 0 || elementCalls.length > 0 || jsxRoots.length > 0;
  if (!routerFound) {
    // No router owns these routes, so none is attributed and a relative path has nothing to join.
    reader.readJsxChildren(looseRoutes, null, null, false, true);
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
    .map(({ line, reason }) => ({ line, reason }));
  return {
    routes: mergeParsedRoutes(reader.jsxSites, reader.dataSites),
    dataRoutes: mergeParsedRoutes([], reader.dataSites),
    unreadable,
    dataRouter: dataCalls.length > 0,
    localImports: readLocalImports(program),
  };
}
