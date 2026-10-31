/**
 * Reads the dev server port and protocol from a Vite config for `usabl init`.
 *
 * The config is parsed, never run. A value counts only when it is a literal written in the
 * `server` block of the exported config: `server.port` as a number, and `server.https` as `true`,
 * `false`, or an options object. The basic SSL plugin, `basicSsl()` in `plugins`, turns https on
 * too. Anything set by code, such as `Number(process.env.PORT)`, is reported as unread so init
 * can say so instead of using a port the dev server may not serve. A comment or a string is not
 * code in the syntax tree, so a port written in one is never read.
 */
import { child, children, parseSource, syntaxForFile, type AstNode } from '../primitives/source-ast.js';

/** One server setting: the literal value, absent from the config, or set in a way init cannot read. */
export type ViteSetting<T> = { value: T } | { absent: true } | { unread: true };

export interface ViteServer {
  port: ViteSetting<number>;
  https: ViteSetting<boolean>;
}

const UNREAD: ViteServer = { port: { unread: true }, https: { unread: true } };

// Wrappers the parser keeps around an expression that do not change its value.
const TRANSPARENT = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression']);

function unwrap(node: AstNode | null): AstNode | null {
  let current = node;
  while (current !== null && TRANSPARENT.has(current.type)) current = child(current, 'expression');
  return current;
}

function keyName(property: AstNode): string | null {
  if (property['computed'] === true) return null;
  const key = child(property, 'key');
  if (key?.type === 'Identifier' && typeof key['name'] === 'string') return key['name'];
  if (key?.type === 'StringLiteral' && typeof key['value'] === 'string') return key['value'];
  return null;
}

// The value written under `name` in an object literal. `unread` when a spread or a computed key
// after the last plain write could replace it, or when a method or getter supplies it.
function propertyValue(object: AstNode, name: string): AstNode | null | 'unread' {
  let value: AstNode | null | 'unread' = null;
  for (const property of children(object, 'properties')) {
    if (property.type === 'SpreadElement') {
      value = 'unread';
      continue;
    }
    const key = keyName(property);
    if (key === null) {
      value = 'unread';
      continue;
    }
    if (key !== name) continue;
    value = property.type === 'ObjectProperty' ? child(property, 'value') : 'unread';
  }
  return value;
}

// The object a function returns: an arrow with an object body, or a block whose last statement
// returns one.
function returnedObject(fn: AstNode): AstNode | null {
  const body = unwrap(child(fn, 'body'));
  if (body?.type === 'ObjectExpression') return body;
  if (body?.type !== 'BlockStatement') return null;
  const statements = children(body, 'body');
  const last = statements[statements.length - 1];
  return last?.type === 'ReturnStatement' ? unwrap(child(last, 'argument')) : null;
}

// The module-level const initializer for a name, when exactly one declares it.
function topLevelConst(program: AstNode, name: string): AstNode | null {
  const found: AstNode[] = [];
  for (const statement of children(program, 'body')) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? child(statement, 'declaration') : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration['kind'] !== 'const') continue;
    for (const declarator of children(declaration, 'declarations')) {
      const id = child(declarator, 'id');
      const init = child(declarator, 'init');
      if (id?.type === 'Identifier' && id['name'] === name && init !== null) found.push(init);
    }
  }
  return found.length === 1 ? (found[0] ?? null) : null;
}

// The exported config object: `export default { ... }`, `defineConfig({ ... })`, a function that
// returns one, or a const that holds any of those.
function configObject(program: AstNode): AstNode | null {
  let exported: AstNode | null = null;
  for (const statement of children(program, 'body')) {
    if (statement.type === 'ExportDefaultDeclaration') exported = child(statement, 'declaration');
  }
  let node = unwrap(exported);
  for (let depth = 0; depth < 4 && node !== null; depth += 1) {
    if (node.type === 'ObjectExpression') return node;
    if (node.type === 'Identifier' && typeof node['name'] === 'string') {
      node = unwrap(topLevelConst(program, node['name']));
      continue;
    }
    if (node.type === 'CallExpression') {
      const callee = unwrap(child(node, 'callee'));
      const args = children(node, 'arguments');
      if (callee?.type !== 'Identifier' || callee['name'] !== 'defineConfig' || args.length !== 1) return null;
      node = unwrap(args[0] ?? null);
      continue;
    }
    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      node = returnedObject(node);
      continue;
    }
    return null;
  }
  return null;
}

function usesBasicSsl(config: AstNode): boolean {
  const plugins = propertyValue(config, 'plugins');
  if (plugins === null || plugins === 'unread') return false;
  const list = unwrap(plugins);
  if (list?.type !== 'ArrayExpression') return false;
  return children(list, 'elements').some((element) => {
    const call = unwrap(element);
    const callee = call?.type === 'CallExpression' ? unwrap(child(call, 'callee')) : null;
    return callee?.type === 'Identifier' && callee['name'] === 'basicSsl';
  });
}

export function readViteServer(raw: string, file: string): ViteServer {
  const parsed = parseSource(raw, syntaxForFile(file));
  if (!parsed.ok) return UNREAD;
  const config = configObject(parsed.program);
  if (config === null) return UNREAD;
  const sslPlugin = usesBasicSsl(config);
  const serverValue = propertyValue(config, 'server');
  if (serverValue === 'unread') return UNREAD;
  if (serverValue === null) {
    return { port: { absent: true }, https: sslPlugin ? { value: true } : { absent: true } };
  }
  const server = unwrap(serverValue);
  if (server?.type !== 'ObjectExpression') return UNREAD;

  let port: ViteSetting<number> = { absent: true };
  const portValue = propertyValue(server, 'port');
  if (portValue === 'unread') port = { unread: true };
  else if (portValue !== null) {
    const literal = unwrap(portValue);
    const value = literal?.type === 'NumericLiteral' ? literal['value'] : null;
    port = typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536 ? { value } : { unread: true };
  }

  let https: ViteSetting<boolean> = sslPlugin ? { value: true } : { absent: true };
  const httpsValue = propertyValue(server, 'https');
  if (httpsValue === 'unread') https = { unread: true };
  else if (httpsValue !== null) {
    const literal = unwrap(httpsValue);
    if (literal?.type === 'BooleanLiteral') https = { value: literal['value'] === true || sslPlugin };
    else if (literal?.type === 'ObjectExpression') https = { value: true };
    else https = { unread: true };
  }
  return { port, https };
}
