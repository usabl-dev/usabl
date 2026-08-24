/**
 * Review-hygiene scrubber for Playwright storageState exports.
 * This utility prepares a review copy only.
 * It is not a secret store, and its output must never be committed.
 * Cookie-only scrubbing overstates safety because SPA credentials can live in origin storage.
 * The review copy is never shareable as credential-safe evidence.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRUBBED_VALUE_PATTERN = /^[A-Za-z0-9_-]{20,}$/;
const SENSITIVE_COOKIE_NAME_KEYWORDS = [
  'authorization',
  'password',
  'secret',
  'token',
  'cookie',
  'cookies',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'session',
  'credentials',
  'privatekey',
  'clientsecret',
  'bearer',
  'auth',
];

interface ScrubbedStorageState {
  scrubbed: Record<string, unknown>;
  totalCookies: number;
  scrubbedCookies: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCredentialCookieName(name: string): boolean {
  const normalized = name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return SENSITIVE_COOKIE_NAME_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function scrubCookie(cookie: unknown): { cookie: unknown; counted: boolean; scrubbed: boolean } {
  if (!isRecord(cookie)) {
    return { cookie, counted: false, scrubbed: false };
  }

  const name = cookie.name;
  const value = cookie.value;
  if (typeof name !== 'string' || typeof value !== 'string') {
    return { cookie, counted: false, scrubbed: false };
  }

  const shouldScrub = SCRUBBED_VALUE_PATTERN.test(value) || isCredentialCookieName(name);
  if (!shouldScrub) {
    return { cookie, counted: true, scrubbed: false };
  }

  return {
    cookie: { ...cookie, value: `[SCRUBBED:${name}]` },
    counted: true,
    scrubbed: true,
  };
}

export function scrubStorageStateDocument(document: Record<string, unknown>): ScrubbedStorageState {
  const cookies = Array.isArray(document.cookies) ? document.cookies : [];
  // Drop origin storage from review copies - SPA auth tokens are commonly stored in localStorage or sessionStorage.
  const { cookies: _cookies, origins: _origins, ...scrubbedBase } = document;
  const scrubbedCookies: unknown[] = [];
  let totalCookies = 0;
  let totalScrubbed = 0;

  for (const cookie of cookies) {
    const result = scrubCookie(cookie);
    scrubbedCookies.push(result.cookie);
    if (result.counted) {
      totalCookies += 1;
    }
    if (result.scrubbed) {
      totalScrubbed += 1;
    }
  }

  return {
    scrubbed: {
      ...scrubbedBase,
      cookies: scrubbedCookies,
    },
    totalCookies,
    scrubbedCookies: totalScrubbed,
  };
}

function defaultOutputPath(inputPath: string): string {
  const extension = extname(inputPath);
  const base = basename(inputPath, extension);
  return join(dirname(inputPath), `${base}.scrubbed${extension || '.json'}`);
}

export async function scrubStorageStateFile(
  inputPath: string,
  outputPath?: string,
): Promise<{ outputPath: string; totalCookies: number; scrubbedCookies: number }> {
  const raw = await readFile(inputPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('storageState JSON must be an object');
  }

  const result = scrubStorageStateDocument(parsed);
  const targetPath = outputPath ?? defaultOutputPath(inputPath);
  await writeFile(targetPath, `${JSON.stringify(result.scrubbed, null, 2)}\n`, 'utf8');
  return {
    outputPath: targetPath,
    totalCookies: result.totalCookies,
    scrubbedCookies: result.scrubbedCookies,
  };
}

function isDirectInvoke(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1.length === 0) {
    return false;
  }
  return fileURLToPath(metaUrl) === resolve(argv1);
}

async function main(argv: string[]): Promise<number> {
  const inputPath = argv[2];
  if (inputPath === undefined || inputPath.length === 0) {
    process.stderr.write('Usage: node --experimental-strip-types scripts/scrub-storage-state.ts <storageState.json>\n');
    return 1;
  }

  try {
    const result = await scrubStorageStateFile(inputPath);
    process.stdout.write(
      `scrubbed ${result.scrubbedCookies} of ${result.totalCookies} cookies -> ${result.outputPath}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to scrub storageState: ${message}\n`);
    return 1;
  }
}

if (isDirectInvoke(import.meta.url, process.argv[1])) {
  main(process.argv).then((exitCode) => process.exit(exitCode));
}
