/**
 * The judge's browser runs the pull request's page script, so it may only talk to the app
 * origin the trusted configuration names, plus any origin that same trusted configuration
 * lists in judge.allowOrigins. These tests hold the two pure pieces of that: where the allowed
 * set comes from, and how one request URL is judged against it.
 */
import { describe, expect, it } from 'vitest';
import { parseUsablConfig } from '../../src/intake/config.js';
import { resolveIntakeConfig } from '../../src/intake/trusted-config.js';
import {
  allowedOriginsFrom,
  blockedOriginLabel,
  decideRedirectResponse,
  decideRequest,
  decideServerAddress,
  decideWebSocket,
} from '../../src/judge/request-filter.js';

const ALLOWED = new Set(['http://127.0.0.1:5173', 'https://fonts.example.com']);

describe('decideRequest', () => {
  it.each([
    'http://127.0.0.1:5173/',
    'http://127.0.0.1:5173/assets/app.js?v=1',
    'https://fonts.example.com/css2?family=Red+Hat',
    'data:text/plain,hello',
    'blob:http://127.0.0.1:5173/0b7c9a2e',
    'about:blank',
  ])('allows %s', (url) => {
    expect(decideRequest(ALLOWED, url)).toBe('allow');
  });

  it.each([
    ['another origin', 'https://evil.example/collect'],
    ['another port on the same host', 'http://127.0.0.1:9999/'],
    ['the same port on another loopback name', 'http://localhost:5173/'],
    ['https on the app host', 'https://127.0.0.1:5173/'],
    ['a cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['a file URL', 'file:///etc/passwd'],
    ['an allowed host on another scheme', 'http://fonts.example.com/'],
    ['something that is not a URL', 'not a url'],
  ])('blocks %s', (_label, url) => {
    expect(decideRequest(ALLOWED, url)).toBe('block');
  });

  it('blocks everything when nothing is allowed', () => {
    expect(decideRequest(new Set(), 'http://127.0.0.1:5173/')).toBe('block');
  });
});

describe('decideWebSocket', () => {
  // Request routing does not see WebSockets, so they are judged on their own: a socket may reach
  // only the host and port of an allowed origin, over the matching secure or plain scheme.
  it.each(['ws://127.0.0.1:5173/hmr', 'wss://fonts.example.com/socket'])('allows %s', (url) => {
    expect(decideWebSocket(ALLOWED, url)).toBe('allow');
  });

  it.each([
    ['another origin', 'wss://evil.example/socket'],
    ['another port on the app host', 'ws://127.0.0.1:9999/'],
    ['the plain scheme for an https origin', 'ws://fonts.example.com/socket'],
    ['the secure scheme for an http origin', 'wss://127.0.0.1:5173/'],
    ['an http URL', 'http://127.0.0.1:5173/'],
    ['something that is not a URL', 'not a url'],
  ])('blocks %s', (_label, url) => {
    expect(decideWebSocket(ALLOWED, url)).toBe('block');
  });
});

describe('blockedOriginLabel', () => {
  it('names the origin, never the path or query a page could fill with data', () => {
    expect(blockedOriginLabel('https://evil.example/collect?token=abc')).toBe('https://evil.example');
    expect(blockedOriginLabel('file:///etc/passwd')).toBe('file:');
    expect(blockedOriginLabel('not a url')).toBe('an unparseable URL');
  });
});

describe('allowedOriginsFrom', () => {
  const config = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      appBaseUrl: 'http://127.0.0.1:5173/app',
      uiFileGlobs: ['src/**'],
      discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
      surfaces: [],
      guardedPaths: [],
      ...extra,
    });

  it('allows the trusted app origin', () => {
    expect(allowedOriginsFrom(config(), null)).toEqual(['http://127.0.0.1:5173']);
  });

  it('adds the trusted judge.allowOrigins', () => {
    const origins = allowedOriginsFrom(config({ judge: { allowOrigins: ['https://fonts.example.com'] } }), null);
    expect(origins).toEqual(['http://127.0.0.1:5173', 'https://fonts.example.com']);
  });

  it('adds the trusted docs origin when a docs manifest is present', () => {
    const docs = JSON.stringify({ docsBaseUrl: 'http://127.0.0.1:8000/docs/' });
    expect(allowedOriginsFrom(config(), docs)).toEqual(['http://127.0.0.1:5173', 'http://127.0.0.1:8000']);
  });

  it('allows nothing when the trusted config is missing or unreadable', () => {
    // No trusted config means no trusted origin, so every request is blocked and every screen
    // is a coverage gap. That fails closed; a head-controlled origin is never used instead.
    expect(allowedOriginsFrom(null, null)).toEqual([]);
    expect(allowedOriginsFrom('{ not json', null)).toEqual([]);
  });
});

describe('judge.allowOrigins in usabl.config.json', () => {
  const base = {
    appBaseUrl: 'http://127.0.0.1:5173',
    uiFileGlobs: ['src/**'],
    discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
    surfaces: [],
    guardedPaths: [],
  };

  it('parses a list of origins', () => {
    const parsed = parseUsablConfig(JSON.stringify({ ...base, judge: { allowOrigins: ['https://fonts.example.com'] } }));
    expect(parsed.judge).toEqual({ allowOrigins: ['https://fonts.example.com'] });
  });

  it.each([
    ['a path', 'https://fonts.example.com/css'],
    ['a non-http scheme', 'ftp://fonts.example.com'],
    ['not a URL', 'fonts'],
  ])('refuses an entry with %s', (_label, entry) => {
    expect(() => parseUsablConfig(JSON.stringify({ ...base, judge: { allowOrigins: [entry] } }))).toThrow(
      /judge\.allowOrigins/,
    );
  });

  it('refuses an unknown key under judge', () => {
    expect(() => parseUsablConfig(JSON.stringify({ ...base, judge: { allowOrigin: [] } }))).toThrow(/judge/);
  });

  it('is dropped when the trusted config cannot be read, like engines', async () => {
    const working = parseUsablConfig(JSON.stringify({ ...base, judge: { allowOrigins: ['https://evil.example'] } }));
    const resolved = await resolveIntakeConfig({ show: async () => null }, working, 'origin/main');
    expect(resolved.judge).toBeUndefined();
  });
});

describe('decideServerAddress', () => {
  // A request whose origin is allowed can still reach a server it should not: an allowed hostname
  // whose DNS answer is a loopback or private address, or a loopback origin answered on another
  // port. The address the response came from is checked against the URL.
  const allowed = new Set(['http://127.0.0.1:5173', 'https://fonts.example.com', 'http://localhost:8080', 'http://[::1]:9000']);

  it.each([
    ['http://127.0.0.1:5173/app.js', '127.0.0.1', 5173],
    ['http://localhost:8080/api', '127.0.0.1', 8080],
    ['http://localhost:8080/api', '::1', 8080],
    ['http://[::1]:9000/x', '::1', 9000],
    ['https://fonts.example.com/css', '93.184.216.34', 443],
    ['https://fonts.example.com/css', '2606:2800:220:1:248:1893:25c8:1946', 443],
  ])('expects %s answered by %s:%d', (url, ipAddress, port) => {
    expect(decideServerAddress(allowed, url, { ipAddress, port })).toBe('expected');
  });

  it.each([
    ['the app origin answered on another loopback port', 'http://127.0.0.1:5173/app.js', '127.0.0.1', 5174],
    ['the app origin answered by another loopback address', 'http://127.0.0.1:5173/app.js', '127.0.0.2', 5173],
    ['localhost answered by a public address', 'http://localhost:8080/api', '93.184.216.34', 8080],
    ['an allowed hostname that resolved to loopback', 'https://fonts.example.com/css', '127.0.0.1', 443],
    ['an allowed hostname that resolved to IPv6 loopback', 'https://fonts.example.com/css', '::1', 443],
    ['an allowed hostname that resolved to a private address', 'https://fonts.example.com/css', '10.0.0.5', 443],
    ['an allowed hostname that resolved to a link-local address', 'https://fonts.example.com/css', '169.254.169.254', 443],
    ['an allowed hostname that resolved to a mapped loopback address', 'https://fonts.example.com/css', '::ffff:127.0.0.1', 443],
    ['an allowed hostname that resolved to a unique local address', 'https://fonts.example.com/css', 'fd00::1', 443],
    ['an allowed hostname answered on another port', 'https://fonts.example.com/css', '93.184.216.34', 8443],
    ['an origin that is not allowed at all', 'https://evil.example/x', '93.184.216.34', 443],
  ])('catches %s', (_label, url, ipAddress, port) => {
    expect(decideServerAddress(allowed, url, { ipAddress, port })).toBe('unexpected');
  });

  it('has nothing to check for a response that did not come from the network', () => {
    expect(decideServerAddress(allowed, 'data:text/plain,x', { ipAddress: '', port: 0 })).toBe('expected');
  });
});

describe('decideRedirectResponse', () => {
  const allowed = new Set(['http://127.0.0.1:5173', 'http://127.0.0.1:6000']);

  it('catches a redirect whose Location leaves the allowed origins', () => {
    expect(decideRedirectResponse(allowed, 'http://127.0.0.1:5173/hop', 'http://127.0.0.1:9999/away', { ipAddress: '127.0.0.1', port: 5173 })).toEqual({
      hop: 'block',
      address: 'expected',
    });
    // A relative Location resolves against the response URL.
    expect(decideRedirectResponse(allowed, 'http://127.0.0.1:5173/hop', '/login', { ipAddress: '127.0.0.1', port: 5173 })).toEqual({
      hop: 'allow',
      address: 'expected',
    });
  });

  it('accepts a redirect response reported at the address of its own server or of the allowed origin it points to', () => {
    expect(
      decideRedirectResponse(allowed, 'http://127.0.0.1:5173/hop', 'http://127.0.0.1:6000/next', { ipAddress: '127.0.0.1', port: 6000 }).address,
    ).toBe('expected');
    expect(
      decideRedirectResponse(allowed, 'http://127.0.0.1:5173/hop', 'http://127.0.0.1:6000/next', { ipAddress: '127.0.0.1', port: 7000 }).address,
    ).toBe('unexpected');
    // An address that matches only a target outside the allowed set is still unexpected.
    expect(
      decideRedirectResponse(allowed, 'http://127.0.0.1:5173/hop', 'http://127.0.0.1:9999/away', { ipAddress: '127.0.0.1', port: 9999 }).address,
    ).toBe('unexpected');
  });

  it('checks a redirect with no readable Location by its own URL only', () => {
    expect(decideRedirectResponse(allowed, 'http://127.0.0.1:5173/hop', null, { ipAddress: '127.0.0.1', port: 5173 })).toEqual({
      hop: 'allow',
      address: 'expected',
    });
    expect(decideRedirectResponse(allowed, 'http://127.0.0.1:5173/hop', 'http://[not-a-host/', null)).toEqual({ hop: 'block', address: 'expected' });
  });
});
