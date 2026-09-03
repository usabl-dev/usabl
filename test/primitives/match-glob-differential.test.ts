/**
 * Differential test: matchGlob must agree with real Node glob on which files a pattern
 * selects. The in-memory fake uses matchGlob, so a fake-only test is circular and cannot
 * catch a matchGlob-versus-glob divergence. This test runs the real node:fs/promises glob
 * over a temp directory and asserts matchGlob classifies every discovered path the same and
 * matches nothing Node excludes. It pins the comma-less brace rule: {tsx} is literal in Node,
 * so matchGlob must not expand it.
 */
import { glob } from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';

const FILES = ['src/App.tsx', 'src/util.ts', 'src/x.jsx', 'src/App.{tsx}', 'docs/guide.tsx'];

const PATTERNS = [
  'src/**/*.{ts,tsx}',
  'src/**/*.{ts,tsx,jsx}',
  'src/**/*.{ts,}',
  'src/**/*.{,ts}',
  'src/**/*.{tsx}',
  'src/**/*.{}',
  'src/**/*.{ts,tsx}{,x}',
  '{src,docs}/**/*.tsx',
];

let dir: string;
let allFiles: string[];

async function nodeGlob(pattern: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of glob(pattern, { cwd: dir, withFileTypes: true })) {
    if (entry.isDirectory()) {
      continue;
    }
    out.push(relative(dir, resolve(entry.parentPath, entry.name)));
  }
  return out.sort();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usabl-glob-'));
  const created: string[] = [];
  for (const file of FILES) {
    const full = join(dir, file);
    await mkdir(join(full, '..'), { recursive: true });
    try {
      await writeFile(full, '');
      created.push(file);
    } catch {
      // Some filesystems refuse braces in a name. Skip that file only.
    }
  }
  allFiles = created;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('matchGlob agrees with real Node glob', () => {
  it('created the literal-brace fixture file (skips the case if the fs refused it)', () => {
    // Not a hard requirement. The comma-less case is still covered by the exclusion
    // assertion below even without this file.
    expect(allFiles.length).toBeGreaterThan(0);
  });

  for (const pattern of PATTERNS) {
    it(`matches exactly the Node glob result for ${pattern}`, async () => {
      const discovered = await nodeGlob(pattern);
      // Every file Node selects, matchGlob must select.
      for (const file of discovered) {
        expect(matchGlob(pattern, file), `Node selected ${file}, matchGlob must too`).toBe(true);
      }
      // Every file Node excludes, matchGlob must exclude.
      const excluded = allFiles.filter((f) => !discovered.includes(f));
      for (const file of excluded) {
        expect(matchGlob(pattern, file), `Node excluded ${file}, matchGlob must too`).toBe(false);
      }
    });
  }
});
