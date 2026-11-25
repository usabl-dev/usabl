/**
 * The file system adapter's glob never hands Node's fs.glob a part that can backtrack. A pattern
 * with many wildcards is listed wide and filtered with a matcher that does not backtrack, so a long
 * file name cannot make a stop outlast the host's limit. Syntax the filter does not read runs in
 * Node only inside a bound. These tests use real temporary folders.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFsGlob } from '../../src/deps/fs.js';

// The slow shape: `src/`, then `*a` twelve times, then `*b`. Node took seconds on one name of 30
// letters. A run on a loaded machine stays far below this limit.
const SLOW_PATTERN = `src/${'*a'.repeat(12)}*b`;
const QUICK_MS = 1000;

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'usabl-fs-glob-bounded-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(path: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), '');
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await work();
  return { value, ms: performance.now() - start };
}

describe('a pattern with many wildcards', { timeout: 120_000 }, () => {
  it('rules out a long file name quickly and still matches the names it names', async () => {
    await write(`src/${'a'.repeat(30)}`);
    await write(`src/${'a'.repeat(12)}b`);
    await write(`src/x${'a'.repeat(12)}yb`);
    const { value, ms } = await timed(() => makeFsGlob({ cwd: root }).glob([SLOW_PATTERN]));
    expect(value).toEqual([`src/${'a'.repeat(12)}b`, `src/x${'a'.repeat(12)}yb`]);
    expect(ms).toBeLessThan(QUICK_MS);
  });
});

describe('letter case', () => {
  it('matches a folder in other letter case on a platform that ignores case, and not on Linux', async () => {
    await write('SRC/App.tsx');
    await write('src2/App.tsx');
    expect(await makeFsGlob({ cwd: root, platform: 'darwin' }).glob(['src/**'])).toEqual(['SRC/App.tsx']);
    expect(await makeFsGlob({ cwd: root, platform: 'win32' }).glob(['src/**'])).toEqual(['SRC/App.tsx']);
    expect(await makeFsGlob({ cwd: root, platform: 'linux' }).glob(['src/**'])).toEqual([]);
  });

  it('matches a wildcard part in other letter case only on a platform that ignores case', async () => {
    await write('src/APP.TSX');
    expect(await makeFsGlob({ cwd: root, platform: 'darwin' }).glob(['src/*.tsx'])).toEqual(['src/APP.TSX']);
    expect(await makeFsGlob({ cwd: root, platform: 'linux' }).glob(['src/*.tsx'])).toEqual([]);
  });
});

describe('syntax the filter does not read', { timeout: 120_000 }, () => {
  it('runs a character class in Node inside the bound', async () => {
    await write('src/a1.ts');
    await write('src/b1.ts');
    expect(await makeFsGlob({ cwd: root }).glob(['src/[a]*.ts'])).toEqual(['src/a1.ts']);
  });

  it('does not run an extglob group, which can take Node a very long time', async () => {
    // One extglob group took Node 27 seconds against a name of 40 letters.
    await write(`src/${'a'.repeat(36)}`);
    const { value, ms } = await timed(() => makeFsGlob({ cwd: root }).glob(['src/+(a|aa)b']));
    expect(value).toEqual([]);
    expect(ms).toBeLessThan(QUICK_MS);
  });
});
