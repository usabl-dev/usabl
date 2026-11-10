import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { figmaApiBase, FigmaFetchError, fetchFigmaFile } from '../../../src/import/figma/fetch.js';
import { MOCK_TOKEN, startMockFigma, type MockFigma } from './mock-server.js';

function baseOf(raw: string): URL {
  const read = figmaApiBase({ FIGMA_API_BASE: raw });
  if (!read.ok) throw new Error(read.message);
  return read.base;
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FigmaFetchError);
    return (error as Error).message;
  }
  throw new Error('expected the fetch to fail');
}

describe('figmaApiBase', () => {
  it("is Figma's own API unless the environment names another", () => {
    const read = figmaApiBase({});
    expect(read.ok && read.base.href).toBe('https://api.figma.com/');
  });

  it('accepts https anywhere and plain http only on this machine', () => {
    expect(figmaApiBase({ FIGMA_API_BASE: 'https://figma.example.test/api' }).ok).toBe(true);
    expect(figmaApiBase({ FIGMA_API_BASE: 'http://127.0.0.1:4010' }).ok).toBe(true);
    expect(figmaApiBase({ FIGMA_API_BASE: 'http://localhost:4010' }).ok).toBe(true);
    expect(figmaApiBase({ FIGMA_API_BASE: 'http://[::1]:4010' }).ok).toBe(true);
    expect(figmaApiBase({ FIGMA_API_BASE: 'http://figma.example.test' }).ok).toBe(false);
  });

  it.each([
    ['not a URL', 'figma'],
    ['another scheme', 'file:///etc/passwd'],
    ['sign-in details', 'https://user:pass@figma.example.test'],
    ['a query', 'https://figma.example.test/?x=1'],
    ['a fragment', 'https://figma.example.test/#x'],
  ])('refuses a base with %s, and never repeats it', (_, raw) => {
    const read = figmaApiBase({ FIGMA_API_BASE: raw });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.message).toContain('FIGMA_API_BASE');
      expect(read.message).not.toContain('pass');
    }
  });
});

describe('fetchFigmaFile', () => {
  let mock: MockFigma;
  let elsewhere: Server;
  let elsewhereHits = 0;
  let elsewhereUrl = '';
  let redirecting: MockFigma;

  beforeAll(async () => {
    mock = await startMockFigma();
    elsewhere = createServer((_req, res) => {
      elsewhereHits += 1;
      res.writeHead(200).end('{}');
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
    const address = elsewhere.address();
    elsewhereUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/steal`;
    redirecting = await startMockFigma(undefined, 0, { redirectTo: elsewhereUrl });
  });

  afterAll(async () => {
    await mock.close();
    await redirecting.close();
    await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
  });

  it('reads the file with one GET to the files endpoint, with the token in its header', async () => {
    const before = mock.seen.length;
    const file = await fetchFigmaFile(baseOf(mock.base), 'MOCKKEY', MOCK_TOKEN);
    expect(file.version).toBe('4242');
    expect(mock.seen.slice(before)).toEqual([{ method: 'GET', url: '/v1/files/MOCKKEY', token: MOCK_TOKEN }]);
  });

  it('refuses a file key it could not put in a URL safely, before any request', async () => {
    const before = mock.seen.length;
    const message = await failure(fetchFigmaFile(baseOf(mock.base), '../admin', MOCK_TOKEN));
    expect(message).toContain('file key');
    expect(mock.seen.length).toBe(before);
  });

  it('explains a refused token and never repeats it', async () => {
    const message = await failure(fetchFigmaFile(baseOf(mock.base), 'MOCKKEY', 'wrong-secret-value'));
    expect(message).toBe('Figma refused the token. Check that FIGMA_TOKEN can read this file.');
  });

  it('names an unknown file key', async () => {
    expect(await failure(fetchFigmaFile(baseOf(mock.base), 'NOPE', MOCK_TOKEN))).toBe(
      'Figma has no file with key NOPE, or the token cannot see it.',
    );
  });

  it('never repeats what an error answer says, which can echo the request', async () => {
    const message = await failure(fetchFigmaFile(baseOf(mock.base), 'BUSY', MOCK_TOKEN));
    expect(message).toBe("Figma answered 500. Try again later, or check Figma's status page.");
    expect(message).not.toContain(MOCK_TOKEN);
  });

  it('refuses an answer that is not a Figma file', async () => {
    const empty = await startMockFigma({});
    try {
      expect(await failure(fetchFigmaFile(baseOf(empty.base), 'MOCKKEY', MOCK_TOKEN))).toBe('Figma returned a file usabl cannot read.');
    } finally {
      await empty.close();
    }
    expect(await failure(fetchFigmaFile(baseOf(mock.base), 'BROKEN', MOCK_TOKEN))).toBe('Figma returned a file usabl cannot read.');
  });

  it('refuses a redirect, so the token never goes to another address', async () => {
    const message = await failure(fetchFigmaFile(baseOf(redirecting.base), 'REDIRECT', MOCK_TOKEN));
    expect(message).toContain('redirect');
    expect(message).not.toContain(MOCK_TOKEN);
    expect(elsewhereHits).toBe(0);
  });

  it('names the address it could not reach, never the token', async () => {
    const closed = await startMockFigma();
    const base = baseOf(closed.base);
    await closed.close();
    const message = await failure(fetchFigmaFile(base, 'MOCKKEY', MOCK_TOKEN));
    expect(message).toBe(`Could not reach the Figma API at ${base.origin}. Check the address and the network.`);
    expect(message).not.toContain(MOCK_TOKEN);
  });
});
