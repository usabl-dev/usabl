/**
 * `usabl import figma` through the main CLI: the command is dispatched, its arguments reach the
 * import parser whole, and the token comes from the environment.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../../src/cli.js';
import { MOCK_TOKEN, startMockFigma, type MockFigma } from './mock-server.js';

let mock: MockFigma;
beforeAll(async () => {
  mock = await startMockFigma();
});
afterAll(async () => {
  await mock.close();
});

describe('usabl import through the main CLI', () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.stubEnv('FIGMA_TOKEN', MOCK_TOKEN);
    vi.stubEnv('FIGMA_API_BASE', mock.base);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('writes the draft file and exits 0', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'usabl-import-main-')), 'figma.yaml');
    const code = await main(['import', 'figma', 'MOCKKEY', '--frame', 'Users=users', '--out', out, '--min-target', '24']);
    expect(stderr.join('')).toBe('');
    expect(code).toBe(0);
    expect(stdout.join('')).toContain(`Wrote 5 draft requirements to ${out}.`);
    expect(readFileSync(out, 'utf8')).toContain('approved: false');
  });

  it('passes a typo in a flag to the import parser, which refuses it', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'usabl-import-main-')), 'typo.yaml');
    const code = await main(['import', 'figma', 'MOCKKEY', '--frames', 'Users=users', '--out', out]);
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(/--frames/u);
    expect(existsSync(out)).toBe(false);
  });

  it('does not print the token when Figma refuses it', async () => {
    vi.stubEnv('FIGMA_TOKEN', 'main-secret-value-123');
    const out = join(mkdtempSync(join(tmpdir(), 'usabl-import-main-')), 'refused.yaml');
    const code = await main(['import', 'figma', 'MOCKKEY', '--frame', 'Users=users', '--out', out]);
    expect(code).toBe(2);
    expect(`${stdout.join('')}${stderr.join('')}`).not.toContain('main-secret-value-123');
    expect(stderr.join('')).toContain('Figma refused the token');
  });
});
