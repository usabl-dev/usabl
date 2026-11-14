/**
 * `usabl serve-build`: the static file server the trusted judge uses to serve a pull request's
 * built app on loopback, so the scan reads exactly the bytes the build produced.
 *
 * The build is untrusted. Its files may be named to escape the root, may be symlinks that point
 * out of it, and the page script it ships may send any path it likes. So every request path is
 * decoded once, refused if any segment is a dot segment or carries a separator, joined under the
 * root, and then resolved with realpath and required to stay inside the root's own realpath. The
 * single-page app fallback goes through the same containment check. Only GET and HEAD are
 * answered, and the server binds only the host it was given.
 *
 * This unit serves files. It never reads a verdict and never decides one.
 */
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, sep } from 'node:path';
import { makeGitReader } from '../deps/git.js';

export interface BuildServer {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface BuildServerOptions {
  dir: string;
  host: string;
  port: number;
}

// Build outputs a browser loads. Anything else is served as bytes, which a browser will not
// run as script or style because the server also sends nosniff.
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

type Resolution =
  | { kind: 'file'; path: string; size: number }
  | { kind: 'bad-request' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' };

function isInside(rootReal: string, candidateReal: string): boolean {
  return candidateReal === rootReal || candidateReal.startsWith(rootReal + sep);
}

function errorCode(error: unknown): string | null {
  const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' ? code : null;
}

// Resolve one path on disk and serve it only if its realpath stays inside the root. A directory
// serves its own index.html, which is resolved and checked the same way.
async function resolveContained(rootReal: string, candidate: string): Promise<Resolution> {
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { kind: 'not-found' };
    }
    throw error;
  }
  if (!isInside(rootReal, real)) {
    return { kind: 'forbidden' };
  }
  const info = await stat(real);
  if (info.isDirectory()) {
    return resolveContained(rootReal, join(real, 'index.html'));
  }
  // Only a regular file is served. A FIFO or a device in the build would hang or leak a read.
  if (!info.isFile()) {
    return { kind: 'not-found' };
  }
  return { kind: 'file', path: real, size: info.size };
}

/**
 * Map a request target to a file under the root. Exported for tests through the server only;
 * the decoding rules live here so there is one place that decides what a path may name.
 */
async function resolveRequest(rootReal: string, target: string): Promise<Resolution> {
  // The query and fragment never name a file.
  const pathPart = target.split(/[?#]/, 1)[0] ?? '';
  if (!pathPart.startsWith('/')) {
    return { kind: 'bad-request' };
  }
  const segments: string[] = [];
  for (const raw of pathPart.split('/').slice(1)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return { kind: 'bad-request' };
    }
    if (decoded === '') {
      continue;
    }
    // Decoded once, then refused outright rather than normalized: a dot segment or a separator
    // inside a segment is only ever an attempt to name something the plain path does not.
    if (decoded === '.' || decoded === '..') {
      return { kind: 'forbidden' };
    }
    if (decoded.includes('/') || decoded.includes('\\')) {
      return { kind: 'forbidden' };
    }
    if (decoded.includes('\0')) {
      return { kind: 'bad-request' };
    }
    segments.push(decoded);
  }

  const direct = await resolveContained(rootReal, join(rootReal, ...segments));
  if (direct.kind !== 'not-found') {
    return direct;
  }
  // Single-page app routes have no file. A last segment with no extension is a route, so it
  // gets the root index.html. A missing file with an extension is a broken build and stays 404.
  const last = segments[segments.length - 1] ?? '';
  if (extname(last) !== '') {
    return direct;
  }
  return resolveContained(rootReal, join(rootReal, 'index.html'));
}

function sendStatus(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  const body = `${status}\n`;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(body);
}

async function handle(rootReal: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendStatus(res, 405, { allow: 'GET, HEAD' });
    return;
  }
  const resolution = await resolveRequest(rootReal, req.url ?? '/');
  if (resolution.kind === 'bad-request') {
    sendStatus(res, 400);
    return;
  }
  if (resolution.kind === 'forbidden') {
    sendStatus(res, 403);
    return;
  }
  if (resolution.kind === 'not-found') {
    sendStatus(res, 404);
    return;
  }
  res.writeHead(200, {
    'content-type': contentTypeFor(resolution.path),
    'content-length': String(resolution.size),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(resolution.path);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export async function startBuildServer(options: BuildServerOptions): Promise<BuildServer> {
  const rootReal = await realpath(options.dir);
  const server = createServer((req, res) => {
    handle(rootReal, req, res).catch(() => {
      if (!res.headersSent) {
        sendStatus(res, 500);
      } else {
        res.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : options.port;
  const urlHost = options.host.includes(':') ? `[${options.host}]` : options.host;
  return {
    host: options.host,
    port,
    url: `http://${urlHost}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export type ServeBuildArgs =
  | { dir: string; host: string; port: number }
  | { dir: string; trustedRef: string };

export function parseServeBuildArgs(
  argv: string[],
): { ok: true; options: ServeBuildArgs } | { ok: false; message: string } {
  let dir: string | null = null;
  let host: string | null = null;
  let port: string | null = null;
  let trustedRef: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const takesValue = token === '--dir' || token === '--host' || token === '--port' || token === '--trusted-ref';
    if (!takesValue) {
      return { ok: false, message: `serve-build does not know ${token ?? ''}` };
    }
    // A ref that starts with a dash reads as an option to git, so it is refused the way the main
    // CLI refuses it, with the same words.
    if (token === '--trusted-ref' && (value === undefined || value.startsWith('-'))) {
      return { ok: false, message: '--trusted-ref requires a value, such as --trusted-ref origin/main' };
    }
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, message: `serve-build ${token === '--dir' ? '--dir' : token} needs a value` };
    }
    if (token === '--dir') dir = value;
    if (token === '--host') host = value;
    if (token === '--port') port = value;
    if (token === '--trusted-ref') trustedRef = value;
    index += 1;
  }
  if (dir === null) {
    return { ok: false, message: 'serve-build needs --dir <built app directory>' };
  }
  if (trustedRef !== null) {
    if (port !== null || host !== null) {
      return { ok: false, message: 'serve-build takes either --trusted-ref or --host and --port, not both' };
    }
    return { ok: true, options: { dir, trustedRef } };
  }
  if (port === null || !/^\d+$/.test(port) || Number(port) > 65535) {
    return { ok: false, message: 'serve-build needs --port <0-65535>, or --trusted-ref <git ref>' };
  }
  return { ok: true, options: { dir, host: host ?? '127.0.0.1', port: Number(port) } };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// The judge serves the build only on this machine's loopback, at the origin the trusted
// configuration scans. The origin is read from the trusted ref inside the engine, never from the
// head's working tree, so a pull request cannot move the judge to a server of its own. Anything
// but a loopback http origin with an explicit port is a configuration error, never a reason to
// bind elsewhere.
async function originFromTrustedRef(trustedRef: string, cwd: string | undefined): Promise<{ host: string; port: number }> {
  const path = `usabl.config.json at ${trustedRef}`;
  const raw = await makeGitReader(cwd === undefined ? {} : { cwd }).show(trustedRef, 'usabl.config.json');
  if (raw === null) {
    throw new Error(`there is no ${path}`);
  }
  const parsed: unknown = JSON.parse(raw);
  const appBaseUrl = parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'appBaseUrl') : undefined;
  if (typeof appBaseUrl !== 'string') {
    throw new Error(`${path} has no appBaseUrl string`);
  }
  let url: URL;
  try {
    url = new URL(appBaseUrl);
  } catch {
    throw new Error(`appBaseUrl in ${path} is not a URL`);
  }
  if (url.protocol !== 'http:') {
    throw new Error(`appBaseUrl in ${path} must use http on loopback for the judge to serve it`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`appBaseUrl in ${path} must be a loopback host (127.0.0.1, localhost, or [::1])`);
  }
  if (url.port === '') {
    throw new Error(`appBaseUrl in ${path} must name an explicit port`);
  }
  const host = url.hostname === '[::1]' ? '::1' : url.hostname;
  return { host, port: Number(url.port) };
}

export interface ServeBuildIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // The repository the trusted ref is read from. Default: the process working directory.
  cwd?: string;
}

/**
 * The CLI command. On success the server keeps listening, which keeps the process alive until it
 * is signalled; the workflow starts it in the background and stops it when the scan is done.
 * Exit 2 means it could not start: bad arguments, a missing root, or an origin it may not bind.
 */
export async function runServeBuild(
  argv: string[],
  io: ServeBuildIo,
): Promise<{ exitCode: number; server?: BuildServer }> {
  const parsed = parseServeBuildArgs(argv);
  if (!parsed.ok) {
    io.stderr(`usabl: ${parsed.message}\n`);
    return { exitCode: 2 };
  }
  const options = parsed.options;
  try {
    const info = await stat(options.dir).catch(() => null);
    if (info === null) {
      io.stderr(`usabl: serve-build root ${options.dir} does not exist\n`);
      return { exitCode: 2 };
    }
    if (!info.isDirectory()) {
      io.stderr(`usabl: serve-build root ${options.dir} is not a directory\n`);
      return { exitCode: 2 };
    }
    const bind = 'trustedRef' in options ? await originFromTrustedRef(options.trustedRef, io.cwd) : options;
    const server = await startBuildServer({ dir: options.dir, host: bind.host, port: bind.port });
    io.stdout(`usabl: serving ${options.dir} at ${server.url}\n`);
    return { exitCode: 0, server };
  } catch (error) {
    io.stderr(`usabl: serve-build could not start: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2 };
  }
}
