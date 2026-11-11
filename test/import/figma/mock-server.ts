/**
 * A local stand-in for Figma's REST API. It answers GET /v1/files/MOCKKEY with the mock design file
 * when the request carries the mock token, and answers the way Figma does otherwise: 403 for a bad
 * token and 404 for an unknown file key. It records each request it gets, so a test can check what
 * usabl sent. Tests and the demo script share this handler.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { usersScreen } from './users-screen.fixture.js';

export const MOCK_TOKEN = 'mock-figma-token';
export const MOCK_FILE_KEY = 'MOCKKEY';

export interface SeenRequest {
  method: string;
  url: string;
  token: string | undefined;
}

export interface MockFigmaOptions {
  // Where GET /v1/files/REDIRECT sends the client, to test that a redirect is refused.
  redirectTo?: string;
}

export function mockFigmaHandler(
  fileBody: unknown = usersScreen,
  seen: SeenRequest[] = [],
  options: MockFigmaOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const body = JSON.stringify(fileBody);
  return (req, res) => {
    const token = req.headers['x-figma-token'];
    seen.push({ method: req.method ?? '', url: req.url ?? '', token: typeof token === 'string' ? token : undefined });
    if (token !== MOCK_TOKEN) {
      res.writeHead(403, { 'content-type': 'application/json' }).end('{"status":403,"err":"Invalid token"}');
      return;
    }
    const match = /^\/v1\/files\/([^/?]+)/u.exec(req.url ?? '');
    if (match?.[1] === 'REDIRECT' && options.redirectTo !== undefined) {
      res.writeHead(302, { location: options.redirectTo }).end();
      return;
    }
    if (match?.[1] === 'BROKEN') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"version": ');
      return;
    }
    if (match?.[1] === 'BUSY') {
      res.writeHead(500, { 'content-type': 'application/json' }).end(`{"status":500,"err":"${MOCK_TOKEN}"}`);
      return;
    }
    if (match === null || match[1] !== MOCK_FILE_KEY) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"status":404,"err":"Not found"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  };
}

export interface MockFigma {
  base: string;
  seen: SeenRequest[];
  close: () => Promise<void>;
}

export async function startMockFigma(fileBody: unknown = usersScreen, port = 0, options: MockFigmaOptions = {}): Promise<MockFigma> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer(mockFigmaHandler(fileBody, seen, options));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${bound}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
