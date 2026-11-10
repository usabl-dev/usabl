/**
 * Reads one Figma file over Figma's REST API with a personal access token.
 *
 * Only `usabl import figma` and `usabl drift design` call this, and only when a person runs them.
 * Nothing on the check, gate, or hook path imports it. It sends one GET to one address: Figma's API,
 * or the base FIGMA_API_BASE names, which tests and demos point at a local mock. A redirect is
 * refused rather than followed, because a followed redirect would send the token header to an
 * address no one chose.
 *
 * Every failure is a FigmaFetchError with a plain message that says what to do next. No message
 * ever holds the token, and no message repeats what an error answer said, since an answer can echo
 * the request. The answer is checked before anything reads it, because it comes from the network.
 */
import { describeFileKeyProblem } from '../../intake/design-source.js';
import { readFigmaFile, type FigmaFile } from './types.js';

export const FIGMA_API_BASE = 'https://api.figma.com';

// How long one request may take before it is given up. A large design file can take a while.
const FETCH_TIMEOUT_MS = 60_000;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class FigmaFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FigmaFetchError';
  }
}

export type ApiBaseRead = { ok: true; base: URL } | { ok: false; message: string };

/**
 * The API base to call: Figma's own, or the one FIGMA_API_BASE names. Another base must use https,
 * or plain http on this machine for a local mock, and must carry no sign-in details, query, or
 * fragment. The message never repeats the value, which could hold a secret.
 */
export function figmaApiBase(env: Readonly<Record<string, string | undefined>>): ApiBaseRead {
  const raw = env['FIGMA_API_BASE'] ?? FIGMA_API_BASE;
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return { ok: false, message: 'FIGMA_API_BASE is not a URL. Leave it unset to use https://api.figma.com.' };
  }
  const local = base.protocol === 'http:' && LOOPBACK_HOSTS.has(base.hostname);
  if (base.protocol !== 'https:' && !local) {
    return {
      ok: false,
      message: 'FIGMA_API_BASE must use https, or plain http only on this machine (127.0.0.1, localhost, or [::1]), because the token travels with the request.',
    };
  }
  if (base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') {
    return { ok: false, message: 'FIGMA_API_BASE must not carry sign-in details, a query, or a fragment.' };
  }
  if (!base.pathname.endsWith('/')) {
    base.pathname = `${base.pathname}/`;
  }
  return { ok: true, base };
}

function statusMessage(status: number, fileKey: string): string {
  if (status === 401 || status === 403) {
    return 'Figma refused the token. Check that FIGMA_TOKEN can read this file.';
  }
  if (status === 404) {
    return `Figma has no file with key ${fileKey}, or the token cannot see it.`;
  }
  if (status === 429) {
    return 'Figma is limiting requests for this token. Wait a few minutes and try again.';
  }
  if (status >= 300 && status < 400) {
    return 'Figma answered with a redirect, which usabl does not follow, because the token would go to another address.';
  }
  return `Figma answered ${status}. Try again later, or check Figma's status page.`;
}

export async function fetchFigmaFile(
  base: URL,
  fileKey: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FigmaFile> {
  const keyProblem = describeFileKeyProblem(fileKey);
  if (keyProblem !== null) {
    throw new FigmaFetchError(`The file key ${keyProblem}.`);
  }
  const url = new URL(`v1/files/${encodeURIComponent(fileKey)}`, base);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'X-Figma-Token': token, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // The error can name the request, so only the origin, which the person chose, is repeated.
    throw new FigmaFetchError(`Could not reach the Figma API at ${base.origin}. Check the address and the network.`);
  }
  if (!response.ok) {
    // The body is not read: an error answer can echo the request, the token included.
    await response.body?.cancel().catch(() => undefined);
    throw new FigmaFetchError(statusMessage(response.status, fileKey));
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new FigmaFetchError('Figma returned a file usabl cannot read.');
  }
  const file = readFigmaFile(body);
  if (file === null) {
    throw new FigmaFetchError('Figma returned a file usabl cannot read.');
  }
  return file;
}
