/**
 * Where the app is served, read for the `usabl install --ci` report. The workflows never take a
 * port from here: the judge serves the build on appBaseUrl at the base commit, and the history
 * scan starts the app on appBaseUrl in main's config, both at run time. This read only lets the
 * report say plainly which origin that is, or what to set before the gate can run.
 *
 * The trusted appBaseUrl in usabl.config.json comes first. Before init has run, the port comes
 * from the app: a --port in the dev script, then server.port in the Vite config, then
 * devServer.port in the webpack dev config. Files are parsed, never run. A port set by code is
 * never guessed; when nothing can be read, the result names every place this looked.
 */
import type { InstallFs } from './index.js';
import { readViteServer } from '../init/vite-server.js';
import { collectEvidence, OVERLAY_CONFIG_CANDIDATES, webpackDevConfig } from './overlay.js';
import { child, children, parseSource, syntaxForFile, walk, type AstNode } from '../primitives/source-ast.js';

export type AppOrigin =
  // appBaseUrl in usabl.config.json is a loopback http origin with an explicit port.
  | { kind: 'config'; origin: string }
  // usabl.config.json exists, but its appBaseUrl is not one the judge can serve.
  | { kind: 'config-invalid'; problem: string }
  // No usabl.config.json yet. The port the app's own files name, and where it came from.
  | { kind: 'app'; port: number; source: string }
  // No usabl.config.json, and no file names a port usabl can read.
  | { kind: 'unread'; lookedIn: string[] };

export const CONFIG_PATH = 'usabl.config.json';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// The same rule the judge applies at the base commit, so the report and the run agree.
function originFromConfig(raw: string): AppOrigin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'config-invalid', problem: `${CONFIG_PATH} does not parse as JSON` };
  }
  const base = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'appBaseUrl') : undefined;
  if (typeof base !== 'string') {
    return { kind: 'config-invalid', problem: `${CONFIG_PATH} has no appBaseUrl string` };
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { kind: 'config-invalid', problem: `appBaseUrl in ${CONFIG_PATH} is not a URL` };
  }
  if (url.protocol !== 'http:') {
    return { kind: 'config-invalid', problem: `appBaseUrl in ${CONFIG_PATH} must use http` };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return { kind: 'config-invalid', problem: `appBaseUrl in ${CONFIG_PATH} must be a loopback host (127.0.0.1, localhost, or [::1])` };
  }
  if (url.port === '') {
    return { kind: 'config-invalid', problem: `appBaseUrl in ${CONFIG_PATH} must name an explicit port` };
  }
  return { kind: 'config', origin: url.origin };
}

async function packageScripts(fs: InstallFs): Promise<Record<string, unknown> | null> {
  const raw = await fs.readFile('package.json');
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const scripts = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'scripts') : undefined;
    return typeof scripts === 'object' && scripts !== null ? (scripts as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether package.json has the dev script the history workflow runs as `npm run dev`. */
export async function hasDevScript(fs: InstallFs): Promise<boolean> {
  const scripts = await packageScripts(fs);
  return typeof scripts?.['dev'] === 'string';
}

function validPort(value: number): number | null {
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
}

// A port number written as a literal: 9000 or '9000'.
function literalPort(node: AstNode | null): number | null {
  if (node?.type === 'NumericLiteral' && typeof node['value'] === 'number') return validPort(node['value']);
  if (node?.type === 'StringLiteral' && typeof node['value'] === 'string' && /^\d+$/.test(node['value'])) {
    return validPort(Number(node['value']));
  }
  return null;
}

// `process.env.NAME`, as the name, or null.
function envName(node: AstNode | null): string | null {
  if (node?.type !== 'MemberExpression' || node['computed'] === true) return null;
  const object = child(node, 'object');
  const property = child(node, 'property');
  if (object?.type !== 'MemberExpression' || object['computed'] === true) return null;
  const root = child(object, 'object');
  const env = child(object, 'property');
  if (root?.type !== 'Identifier' || root['name'] !== 'process' || env?.type !== 'Identifier' || env['name'] !== 'env') return null;
  return property?.type === 'Identifier' && typeof property['name'] === 'string' ? property['name'] : null;
}

// The initializer of the one module-level const, let, or var with this name.
function topLevelBinding(program: AstNode, name: string): AstNode | null {
  const found: AstNode[] = [];
  for (const statement of children(program, 'body')) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declarator of children(statement, 'declarations')) {
      const id = child(declarator, 'id');
      const init = child(declarator, 'init');
      if (id?.type === 'Identifier' && id['name'] === name && init !== null) found.push(init);
    }
  }
  return found.length === 1 ? (found[0] ?? null) : null;
}

type PortRead = { port: number; note: string } | { unread: true } | { absent: true };

// A port value: a literal, a module-level binding that holds one, or `process.env.NAME || <literal>`,
// which the dev server uses when that variable is not set. Anything else is code usabl does not run.
function portValue(program: AstNode, node: AstNode | null, depth = 0): PortRead {
  const literal = literalPort(node);
  if (literal !== null) return { port: literal, note: '' };
  if (node?.type === 'Identifier' && typeof node['name'] === 'string' && depth === 0) {
    return portValue(program, topLevelBinding(program, node['name']), 1);
  }
  if (node?.type === 'LogicalExpression' && (node['operator'] === '||' || node['operator'] === '??')) {
    const name = envName(child(node, 'left'));
    const fallback = literalPort(child(node, 'right'));
    if (name !== null && fallback !== null) return { port: fallback, note: `, the value it uses when ${name} is not set` };
  }
  return { unread: true };
}

// devServer.port from a webpack config. The one `devServer: { ... }` object anywhere in the file
// counts, so a config wrapped in merge() or a function still reads. Two such objects, or a spread
// or computed key in it, is not read.
function readWebpackPort(raw: string, file: string): PortRead {
  const parsed = parseSource(raw, syntaxForFile(file));
  if (!parsed.ok) return { unread: true };
  const servers: AstNode[] = [];
  walk(parsed.program, (node) => {
    if (node.type !== 'ObjectProperty' || node['computed'] === true) return;
    const key = child(node, 'key');
    const name = key?.type === 'Identifier' ? key['name'] : key?.type === 'StringLiteral' ? key['value'] : null;
    if (name === 'devServer') {
      const value = child(node, 'value');
      if (value !== null) servers.push(value);
    }
  });
  if (servers.length === 0) return { absent: true };
  const server = servers[0];
  if (servers.length > 1 || server?.type !== 'ObjectExpression') return { unread: true };
  let port: AstNode | null | 'unread' = null;
  for (const property of children(server, 'properties')) {
    if (property.type !== 'ObjectProperty' || property['computed'] === true) {
      port = 'unread';
      continue;
    }
    const key = child(property, 'key');
    if (key?.type === 'Identifier' && key['name'] === 'port') port = child(property, 'value');
  }
  if (port === 'unread') return { unread: true };
  if (port === null) return { absent: true };
  return portValue(parsed.program, port);
}

export async function readAppOrigin(fs: InstallFs): Promise<AppOrigin> {
  const config = await fs.readFile(CONFIG_PATH);
  if (config !== null) return originFromConfig(config);

  const lookedIn = [`${CONFIG_PATH} (absent)`];

  const scripts = await packageScripts(fs);
  const dev = scripts?.['dev'];
  if (typeof dev === 'string') {
    const match = /(?:^|\s)--port(?:=|\s+)(\d+)(?=\s|$)/.exec(dev);
    const port = match === null ? null : validPort(Number(match[1]));
    if (port !== null) return { kind: 'app', port, source: 'package.json script "dev"' };
    lookedIn.push('package.json script "dev" (no --port)');
  } else {
    lookedIn.push('package.json script "dev" (absent)');
  }

  let viteFile: string | null = null;
  for (const candidate of OVERLAY_CONFIG_CANDIDATES) {
    const raw = await fs.readFile(candidate);
    if (raw === null) continue;
    viteFile = candidate;
    const server = readViteServer(raw, candidate);
    if ('value' in server.port) return { kind: 'app', port: server.port.value, source: candidate };
    if ('absent' in server.port) {
      return { kind: 'app', port: 5173, source: `Vite's default port, because ${candidate} sets no server.port` };
    }
    lookedIn.push(`${candidate} (sets server.port with code usabl does not run)`);
    break;
  }
  if (viteFile === null) lookedIn.push('vite.config.ts, .js, .mts, .mjs, .cts, or .cjs (absent)');

  const webpackFile = webpackDevConfig(await collectEvidence(fs));
  const webpackRaw = webpackFile === null ? null : await fs.readFile(webpackFile);
  if (webpackFile === null || webpackRaw === null) {
    lookedIn.push('webpack configs (none found)');
  } else {
    const read = readWebpackPort(webpackRaw, webpackFile);
    if ('port' in read) return { kind: 'app', port: read.port, source: `${webpackFile}, devServer.port${read.note}` };
    lookedIn.push(
      'absent' in read ? `${webpackFile} (no devServer.port)` : `${webpackFile} (sets devServer.port with code usabl does not run)`,
    );
  }
  return { kind: 'unread', lookedIn };
}

/**
 * What the CI report says about the app origin. With a usable appBaseUrl it is a fact. Otherwise it
 * is a step, because the gate cannot run until usabl.config.json holds one. A port the app files
 * name is offered as the value to set; with none, the step says where usabl looked.
 */
export function appOriginReport(app: AppOrigin): { note: string } | { step: string } {
  const shape = 'an http origin on loopback with an explicit port';
  if (app.kind === 'config') {
    return {
      note: `The judge serves the build on ${app.origin}, the appBaseUrl in ${CONFIG_PATH} at the base commit, and the history scan starts the app with "npm run dev" on the same origin.`,
    };
  }
  if (app.kind === 'config-invalid') {
    return {
      step: `Fix appBaseUrl and commit ${CONFIG_PATH}: ${app.problem}. The judge and the history scan both read it, and both need ${shape}, such as http://127.0.0.1:5173 for a dev server on port 5173.`,
    };
  }
  if (app.kind === 'app') {
    return {
      step: `Run "usabl init" and commit ${CONFIG_PATH}. Its appBaseUrl must be http://127.0.0.1:${app.port}: the port read from ${app.source}. The judge and the history scan both read it.`,
    };
  }
  return {
    step: `Run "usabl init" and commit ${CONFIG_PATH}, then set its appBaseUrl to http://127.0.0.1:<port> with the port your dev server serves on. usabl could not read that port. It looked in: ${app.lookedIn.join('; ')}.`,
  };
}
