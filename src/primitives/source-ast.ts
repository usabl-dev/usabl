/**
 * Reads JavaScript and TypeScript source into a syntax tree, and walks that tree.
 *
 * Route discovery and the source attribute injector both used to scan raw text, so they could not
 * tell code from a string, a comment, or a regular expression. The parser can. This module is the
 * one place usabl calls it, so every caller parses with the same options and handles a file that
 * does not parse the same way: it gets a failure with a position, never an exception and never an
 * empty tree that would read as "nothing here".
 *
 * Only the parser is used. The walk below is a small explicit-stack visitor over the plain node
 * objects the parser returns, so no other Babel package is needed.
 */
import { parse, type ParserPlugin } from '@babel/parser';

/**
 * A syntax tree node as the parser returns it.
 *
 * The parser's own node types come from a package usabl does not depend on directly, so callers
 * read nodes through this loose shape and the small guards below.
 */
export interface AstNode {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
}

export type ParsedSource =
  | { ok: true; program: AstNode }
  | { ok: false; line: number | null; column: number | null };

/**
 * Which syntax a file may hold, from its extension.
 *
 * A `.ts` file is parsed without JSX, because `<Type>value` is a type assertion there and JSX would
 * read it as a tag. A `.js` file is parsed with JSX, because React projects often keep JSX in `.js`
 * files and JSX accepts every plain JavaScript program that does not use `<` as a tag.
 */
export function syntaxForFile(file: string): { typescript: boolean; jsx: boolean } {
  const lower = file.toLowerCase();
  if (lower.endsWith('.tsx')) return { typescript: true, jsx: true };
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return { typescript: true, jsx: false };
  }
  return { typescript: false, jsx: true };
}

function parseWith(code: string, plugins: ParserPlugin[]): ParsedSource {
  try {
    const file = parse(code, { sourceType: 'module', plugins }) as unknown as { program: AstNode };
    return { ok: true, program: file.program };
  } catch (error: unknown) {
    const loc = isRecord(error) && isRecord(error['loc']) ? error['loc'] : null;
    const line = loc !== null && typeof loc['line'] === 'number' ? loc['line'] : null;
    const column = loc !== null && typeof loc['column'] === 'number' ? loc['column'] : null;
    return { ok: false, line, column };
  }
}

/**
 * Parses a module. A syntax error comes back as a failure with its position, never as a throw.
 *
 * Decorators are accepted in the legacy form that TypeScript and Babel projects use, such as
 * `@observer class Store {}`. A JavaScript file that does not parse is tried once more with Flow
 * types, because React projects that use Flow keep its types in `.js` and `.jsx` files. Flow is
 * not tried first: it reads `<T>(x) => x` differently, and most files have no Flow at all. When
 * both attempts fail, the first attempt's position is the one reported.
 */
export function parseSource(code: string, syntax: { typescript: boolean; jsx: boolean }): ParsedSource {
  const plugins: ParserPlugin[] = ['decorators-legacy'];
  if (syntax.jsx) plugins.push('jsx');
  if (syntax.typescript) plugins.push('typescript');
  const first = parseWith(code, plugins);
  if (first.ok || syntax.typescript) return first;
  const withFlow = parseWith(code, [...plugins, 'flow']);
  return withFlow.ok ? withFlow : first;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isNode(value: unknown): value is AstNode {
  return isRecord(value) && typeof value['type'] === 'string';
}

/** The node stored under `key`, or null when that field is absent or not a node. */
export function child(node: AstNode, key: string): AstNode | null {
  const value = node[key];
  return isNode(value) ? value : null;
}

/** The nodes stored under `key`, with holes and non-nodes left out. */
export function children(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

/** One-based line of the node's first character, or null when the parser recorded none. */
export function lineOf(node: AstNode): number | null {
  return node.loc?.start.line ?? null;
}

// Position data and comments are not children. Comments are attached to nodes by the parser, and
// walking them would hand a commented-out route back to the caller as code.
const NOT_CHILDREN = new Set([
  'loc',
  'start',
  'end',
  'range',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'tokens',
]);

/** Every direct child node of `node`, in the order the parser stored them. */
export function childNodes(node: AstNode): AstNode[] {
  const found: AstNode[] = [];
  for (const key of Object.keys(node)) {
    if (NOT_CHILDREN.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) found.push(item);
      }
    } else if (isNode(value)) {
      found.push(value);
    }
  }
  return found;
}

/**
 * Visits `root` and every node below it, parents before children.
 *
 * The visitor gets the node and its ancestors, nearest last. Returning 'skip' leaves that node's
 * children out. The walk keeps its own stack, so a deeply nested file cannot exhaust the call stack.
 */
export function walk(
  root: AstNode,
  visit: (node: AstNode, ancestors: readonly AstNode[]) => 'skip' | void,
): void {
  const stack: Array<{ node: AstNode; ancestors: readonly AstNode[] }> = [{ node: root, ancestors: [] }];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    if (visit(next.node, next.ancestors) === 'skip') continue;
    const below = childNodes(next.node);
    const ancestors = [...next.ancestors, next.node];
    // Pushed in reverse so the first child is visited first.
    for (let i = below.length - 1; i >= 0; i -= 1) {
      const node = below[i];
      if (node !== undefined) stack.push({ node, ancestors });
    }
  }
}
