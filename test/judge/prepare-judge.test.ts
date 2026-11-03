/**
 * prepareJudge is what `check --isolated-browser` does around a run: it reads the allowed origins
 * from the trusted ref, checks the build digest it was handed, counts what the browser blocks,
 * and puts the judge block on the Result. The origin set never comes from the head's files when
 * a trusted ref is given.
 */
import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import { prepareJudge } from '../../src/judge/prepare.js';

const config = (appBaseUrl: string): string =>
  JSON.stringify({
    appBaseUrl,
    uiFileGlobs: ['src/**'],
    discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
    surfaces: [],
    guardedPaths: [],
  });

const result = { schemaVersion: 'usabl.result.v1', exitCode: 0 } as unknown as Result;

describe('prepareJudge', () => {
  it('reads origins from the trusted ref, never from the working tree, when a ref is given', async () => {
    const reads: string[] = [];
    const prepared = await prepareJudge({
      trustedRef: 'origin/main',
      configPath: 'usabl.config.json',
      buildDigestEnv: undefined,
      readAtRef: async (ref, path) => {
        reads.push(`${ref}:${path}`);
        return path === 'usabl.config.json' ? config('http://127.0.0.1:5173') : null;
      },
      readWorking: async () => config('http://evil.example:80'),
      log: () => undefined,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect([...prepared.isolation.allowedOrigins]).toEqual(['http://127.0.0.1:5173']);
    expect(reads).toContain('origin/main:usabl.config.json');
  });

  it('counts blocked requests into the judge block it adds to the Result', async () => {
    const digest = 'b'.repeat(64);
    const prepared = await prepareJudge({
      trustedRef: 'origin/main',
      configPath: 'usabl.config.json',
      buildDigestEnv: digest,
      readAtRef: async (_ref, path) => (path === 'usabl.config.json' ? config('http://127.0.0.1:5173') : null),
      readWorking: async () => null,
      log: () => undefined,
    });
    if (!prepared.ok) throw new Error('expected ok');
    prepared.isolation.onBlocked('https://evil.example/a');
    prepared.isolation.onBlocked('https://evil.example/b');
    expect(prepared.finish(result).judge).toEqual({ isolatedBrowser: true, blockedRequests: 2, buildDigest: digest });
  });

  it('refuses a malformed build digest before anything runs', async () => {
    const prepared = await prepareJudge({
      trustedRef: 'origin/main',
      configPath: 'usabl.config.json',
      buildDigestEnv: 'not-a-digest',
      readAtRef: async () => null,
      readWorking: async () => null,
      log: () => undefined,
    });
    expect(prepared.ok).toBe(false);
  });

  it('allows nothing, and says so, when the trusted ref has no config', async () => {
    const logged: string[] = [];
    const prepared = await prepareJudge({
      trustedRef: 'origin/main',
      configPath: 'usabl.config.json',
      buildDigestEnv: undefined,
      readAtRef: async () => null,
      readWorking: async () => config('http://127.0.0.1:5173'),
      log: (text) => logged.push(text),
    });
    if (!prepared.ok) throw new Error('expected ok');
    expect(prepared.isolation.allowedOrigins.size).toBe(0);
    expect(logged.join('')).toContain('every request will be blocked');
  });

  it('uses the working config only when no trusted ref is given, for a local run', async () => {
    const prepared = await prepareJudge({
      trustedRef: null,
      configPath: 'usabl.config.json',
      buildDigestEnv: undefined,
      readAtRef: async () => {
        throw new Error('no ref to read');
      },
      readWorking: async (path) => (path === 'usabl.config.json' ? config('http://127.0.0.1:4000') : null),
      log: () => undefined,
    });
    if (!prepared.ok) throw new Error('expected ok');
    expect([...prepared.isolation.allowedOrigins]).toEqual(['http://127.0.0.1:4000']);
  });
});
