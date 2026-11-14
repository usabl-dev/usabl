/**
 * serve-build is the static file server the trusted judge uses to serve a pull request's built
 * app. The build is untrusted bytes, so the server's job is to serve those bytes and nothing
 * else: no file outside the root, no other method than GET and HEAD, and no host but the one
 * it was given. These tests drive a real server on an ephemeral port with raw HTTP requests,
 * because a client library would normalize the very paths the server must refuse.
 */
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  contentTypeFor,
  parseServeBuildArgs,
  runServeBuild,
  startBuildServer,
  type BuildServer,
} from '../../src/judge/serve-build.js';

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

// Send the path exactly as written. http.request does not normalize the path, so encoded and
// dot segments reach the server untouched, the way a hostile page script could send them.
function rawRequest(port: number, path: string, method = 'GET'): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

// A build root inside a parent that also holds a secret file, so a traversal that works would
// read it, and a symlink inside the root that points at it.
function makeBuild(): { parent: string; root: string } {
  const parent = mkdtempSync(join(tmpdir(), 'usabl-serve-build-'));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'dist');
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title><p>root index</p>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("app");');
  writeFileSync(join(root, 'assets', 'app.css'), 'body { color: black; }');
  writeFileSync(join(root, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(root, 'docs', 'index.html'), '<!doctype html><title>docs</title><p>docs index</p>');
  writeFileSync(join(root, 'data.json'), '{"ok":true}');
  writeFileSync(join(parent, 'secret.txt'), 'TOP SECRET OUTSIDE THE ROOT');
  symlinkSync(join(parent, 'secret.txt'), join(root, 'escape.txt'));
  symlinkSync(parent, join(root, 'escape-dir'));
  symlinkSync(join(root, 'assets', 'app.js'), join(root, 'inside-link.js'));
  return { parent, root };
}

async function serve(root: string): Promise<BuildServer> {
  const server = await startBuildServer({ dir: root, host: '127.0.0.1', port: 0 });
  cleanups.push(() => server.close());
  return server;
}

describe('startBuildServer path containment', () => {
  it('serves a file inside the root', async () => {
    const { root } = makeBuild();
    const server = await serve(root);
    const res = await rawRequest(server.port, '/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.body).toBe('console.log("app");');
  });

  it.each([
    ['plain dot segments', '/../secret.txt'],
    ['dot segments after a real directory', '/assets/../../secret.txt'],
    ['encoded dots', '/%2e%2e/secret.txt'],
    ['encoded dots in upper case', '/%2E%2E/secret.txt'],
    ['an encoded slash', '/assets%2f..%2f..%2fsecret.txt'],
    ['an encoded backslash', '/..%5csecret.txt'],
    ['double-encoded dots', '/%252e%252e/secret.txt'],
    ['an absolute path smuggled as a segment', '/%2fetc%2fpasswd'],
  ])('never serves the file outside the root through %s', async (_label, path) => {
    const { root } = makeBuild();
    const server = await serve(root);
    const res = await rawRequest(server.port, path);
    expect(res.body).not.toContain('TOP SECRET');
    expect([400, 403, 404]).toContain(res.status);
  });

  it('refuses a symlink that points at a file outside the root', async () => {
    const { root } = makeBuild();
    const server = await serve(root);
    const res = await rawRequest(server.port, '/escape.txt');
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('refuses a path through a symlinked directory that leaves the root', async () => {
    const { root } = makeBuild();
    const server = await serve(root);
    const res = await rawRequest(server.port, '/escape-dir/secret.txt');
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('serves a symlink whose target stays inside the root', async () => {
    const { root } = makeBuild();
    const server = await serve(root);
    const res = await rawRequest(server.port, '/inside-link.js');
    expect(res.status).toBe(200);
    expect(res.body).toBe('console.log("app");');
  });

  it('refuses a NUL byte in the path', async () => {
    const { root } = makeBuild();
    const server = await serve(root);
    const res = await rawRequest(server.port, '/index.html%00.js');
    expect([400, 404]).toContain(res.status);
  });
});

describe('startBuildServer single-page app fallback', () => {
  it('serves the root index.html for an extensionless route that has no file', async () => {
    const { root } = makeBuild();
    const server = await serve(root);
    const res = await rawRequest(server.port, '/clusters/42');
    expect(res.status).toBe(200);
    expect(res.body).toContain('root index');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('serves a directory index.html for a directory path', async () => {
    const { root } = makeBuild();
    const server = await serve(root);
    expect((await rawRequest(server.port, '/')).body).toContain('root index');
    expect((await rawRequest(server.port, '/docs/')).body).toContain('docs index');
    expect((await rawRequest(server.port, '/docs')).body).toContain('docs index');
  });

  it('answers 404 for a missing file that has an extension, never the index', async () => {
    // A missing script served as HTML would hide a broken build behind a page that loads.
    const { root } = makeBuild();
    const server = await serve(root);
    const res = await rawRequest(server.port, '/assets/missing.js');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('root index');
  });

  it('ignores the query string when it resolves the path', async () => {
    const { root } = makeBuild();
    const server = await serve(root);
    const res = await rawRequest(server.port, '/assets/app.js?v=3#x');
    expect(res.status).toBe(200);
    expect(res.body).toBe('console.log("app");');
  });
});

describe('startBuildServer methods and headers', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('answers 405 to %s', async (method) => {
    const { root } = makeBuild();
    const server = await serve(root);
    const res = await rawRequest(server.port, '/index.html', method);
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET, HEAD');
  });

  it('answers HEAD with the headers and no body', async () => {
    const { root } = makeBuild();
    const server = await serve(root);
    const res = await rawRequest(server.port, '/assets/app.js', 'HEAD');
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['content-length']).toBe(String('console.log("app");'.length));
  });

  it('sends the content type for each kind of file and forbids sniffing', async () => {
    const { root } = makeBuild();
    const server = await serve(root);
    const css = await rawRequest(server.port, '/assets/app.css');
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers['x-content-type-options']).toBe('nosniff');
    expect((await rawRequest(server.port, '/assets/logo.svg')).headers['content-type']).toBe('image/svg+xml');
    expect((await rawRequest(server.port, '/data.json')).headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
  });

  it('names a content type for common build outputs and falls back to bytes', () => {
    expect(contentTypeFor('a.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('a.mjs')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('a.woff2')).toBe('font/woff2');
    expect(contentTypeFor('a.png')).toBe('image/png');
    expect(contentTypeFor('a.wasm')).toBe('application/wasm');
    expect(contentTypeFor('a.unknown')).toBe('application/octet-stream');
    expect(contentTypeFor('LICENSE')).toBe('application/octet-stream');
  });

  it('listens only on the host it was given', async () => {
    const { root } = makeBuild();
    const server = await serve(root);
    expect(server.host).toBe('127.0.0.1');
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
  });
});

describe('parseServeBuildArgs', () => {
  it('reads dir, host, and port', () => {
    expect(parseServeBuildArgs(['--dir', 'dist', '--host', '127.0.0.1', '--port', '5173'])).toEqual({
      ok: true,
      options: { dir: 'dist', host: '127.0.0.1', port: 5173 },
    });
  });

  it('takes host and port from the trusted ref app origin when no port is given', () => {
    expect(parseServeBuildArgs(['--dir', 'dist', '--trusted-ref', 'origin/main'])).toEqual({
      ok: true,
      options: { dir: 'dist', trustedRef: 'origin/main' },
    });
  });

  it.each([
    [[], 'dir'],
    [['--dir'], 'dir'],
    [['--dir', 'dist'], 'port'],
    [['--dir', 'dist', '--port', 'abc'], 'port'],
    [['--dir', 'dist', '--port', '70000'], 'port'],
    [['--dir', 'dist', '--port', '80', '--trusted-ref', 'origin/main'], 'either'],
    [['--dir', 'dist', '--port', '80', '--bogus'], '--bogus'],
  ])('refuses %j', (argv, mention) => {
    const parsed = parseServeBuildArgs(argv as string[]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain(mention);
    }
  });

  // The main CLI refuses a --trusted-ref value that starts with any dash. serve-build refused only
  // two, so a value such as -x reached git as the ref.
  it.each([['-x'], ['-Ofile'], ['--output=written']])('refuses the trusted ref %s, as the CLI does', (ref) => {
    expect(parseServeBuildArgs(['--dir', 'dist', '--trusted-ref', ref])).toEqual({
      ok: false,
      message: '--trusted-ref requires a value, such as --trusted-ref origin/main',
    });
  });
});

describe('runServeBuild', () => {
  function io(): { out: string[]; err: string[]; stdout: (s: string) => void; stderr: (s: string) => void } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
  }

  it('exits 2 when the root does not exist', async () => {
    const streams = io();
    const outcome = await runServeBuild(
      ['--dir', join(tmpdir(), 'usabl-no-such-build-root'), '--host', '127.0.0.1', '--port', '0'],
      streams,
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.server).toBeUndefined();
    expect(streams.err.join('')).toContain('does not exist');
  });

  it('exits 2 when the root is a file', async () => {
    const { root } = makeBuild();
    const streams = io();
    const outcome = await runServeBuild(
      ['--dir', join(root, 'index.html'), '--host', '127.0.0.1', '--port', '0'],
      streams,
    );
    expect(outcome.exitCode).toBe(2);
  });

  it('exits 2 on a bad argument list', async () => {
    const streams = io();
    expect((await runServeBuild(['--dir'], streams)).exitCode).toBe(2);
  });

  it('starts, reports where it listens, and serves', async () => {
    const { root } = makeBuild();
    const streams = io();
    const outcome = await runServeBuild(['--dir', root, '--host', '127.0.0.1', '--port', '0'], streams);
    expect(outcome.exitCode).toBe(0);
    const server = outcome.server;
    expect(server).toBeDefined();
    if (server === undefined) return;
    cleanups.push(() => server.close());
    expect(streams.out.join('')).toContain(server.url);
    expect((await rawRequest(server.port, '/')).body).toContain('root index');
  });

  // A repository whose trusted ref carries one usabl.config.json and whose working tree carries
  // another, so a test can tell which one chose the origin.
  function repoWithConfigs(trustedAppBaseUrl: string, headAppBaseUrl: string): string {
    const repo = mkdtempSync(join(tmpdir(), 'usabl-serve-build-repo-'));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    const git = (...args: string[]): void => {
      const outcome = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8' });
      if (outcome.status !== 0) throw new Error(`git ${args.join(' ')}: ${outcome.stderr}`);
    };
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'usabl.config.json'), JSON.stringify({ appBaseUrl: trustedAppBaseUrl }));
    git('add', 'usabl.config.json');
    git('commit', '--quiet', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(repo, 'usabl.config.json'), JSON.stringify({ appBaseUrl: headAppBaseUrl }));
    git('commit', '--quiet', '--allow-empty', '-am', 'head');
    return repo;
  }

  async function freePort(): Promise<number> {
    const { root } = makeBuild();
    const probe = await startBuildServer({ dir: root, host: '127.0.0.1', port: 0 });
    const port = probe.port;
    await probe.close();
    return port;
  }

  it('binds the loopback origin the trusted ref names, never the one the head names', async () => {
    const { root } = makeBuild();
    const trustedPort = await freePort();
    const headPort = await freePort();
    const repo = repoWithConfigs(`http://127.0.0.1:${trustedPort}/app`, `http://127.0.0.1:${headPort}`);
    const streams = io();
    const outcome = await runServeBuild(['--dir', root, '--trusted-ref', 'origin/main'], { ...streams, cwd: repo });
    expect(outcome.exitCode).toBe(0);
    const server = outcome.server;
    if (server === undefined) return;
    cleanups.push(() => server.close());
    expect(server.port).toBe(trustedPort);
    expect(server.host).toBe('127.0.0.1');
  });

  it.each([
    ['a remote host', 'http://example.com:8080'],
    ['no explicit port', 'http://127.0.0.1'],
    ['https', 'https://127.0.0.1:8443'],
    ['not a URL', 'nonsense'],
  ])('exits 2 when the trusted app origin has %s', async (_label, appBaseUrl) => {
    // The judge serves the build only on this machine's loopback. An origin it cannot bind
    // there is a configuration error to fix, never a reason to listen somewhere else.
    const { root } = makeBuild();
    const repo = repoWithConfigs(appBaseUrl, 'http://127.0.0.1:5173');
    const streams = io();
    const outcome = await runServeBuild(['--dir', root, '--trusted-ref', 'origin/main'], { ...streams, cwd: repo });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.server).toBeUndefined();
  });

  it('exits 2 when the trusted ref has no config', async () => {
    const { root } = makeBuild();
    const repo = repoWithConfigs('http://127.0.0.1:5173', 'http://127.0.0.1:5173');
    const streams = io();
    const outcome = await runServeBuild(['--dir', root, '--trusted-ref', 'origin/no-such-branch'], { ...streams, cwd: repo });
    expect(outcome.exitCode).toBe(2);
  });

  // A shallow clone can lack the trusted commit. git then says the config "exists on disk, but not
  // in" it, which is not the same as a trusted ref with no config.
  it('names the ref, not a missing config, when the trusted commit is not in the repository', async () => {
    const { root } = makeBuild();
    const repo = repoWithConfigs('http://127.0.0.1:5173', 'http://127.0.0.1:5173');
    const absent = 'deadbeef'.repeat(5);
    const streams = io();
    const outcome = await runServeBuild(['--dir', root, '--trusted-ref', absent], { ...streams, cwd: repo });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.server).toBeUndefined();
    const err = streams.err.join('');
    expect(err).toContain(`git cannot read ${absent}`);
    expect(err).not.toContain('there is no usabl.config.json');
  });
});

describe('usabl serve-build through the CLI', () => {
  it('dispatches to the server and exits 2 on a missing root', async () => {
    const { main } = await import('../../src/cli.js');
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const code = await main(['serve-build', '--dir', join(tmpdir(), 'usabl-no-such-build-root'), '--port', '0']);
      expect(code).toBe(2);
    } finally {
      spy.mockRestore();
    }
    // The command's own refusal, not the generic unknown-command one.
    expect(written.join('')).toContain('does not exist');

    // Importing the whole CLI is slow on a loaded machine; the check itself is instant.
  }, 60_000);
});
