/**
 * On macOS and Windows, Node's glob matches without regard to letter case. The guard's working-tree
 * listing there must cost about what it costs on Linux: a guarded file entry such as
 * `usabl.config.json/**` must never walk the whole repository. These tests use a real git
 * repository with thousands of untracked files outside every guarded folder, the real adapters,
 * and an injected platform.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Deps } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { expandConfigGuardedSet } from '../../src/trust/guard.js';

const execFileAsync = promisify(execFile);

// 150 packages of 100 files each outside every guarded folder.
const PACKAGES = 150;
const FILES_PER_PACKAGE = 100;
// The listing took about 0.1 seconds here on Linux. A walk of the whole tree for each guarded
// entry took tens of seconds, so these limits catch it with a wide margin for a loaded machine.
const QUICK_MS = 3000;
const HEAP_GROWTH_BYTES = 256 * 1024 * 1024;
// Writing and removing the tree is not what the test measures, so it has its own long limit.
const SETUP_MS = 120_000;

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

async function write(root: string, path: string, text = 'x\n'): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

describe('the guard working-tree listing on a platform that ignores case', { timeout: 120_000 }, () => {
  let root = '';
  let guardedPaths: string[] = [];

  beforeAll(async () => {
    // The guarded paths of this repository, so the entries are the ones a real config holds.
    const own = JSON.parse(await readFile(new URL('../../usabl.config.json', import.meta.url), 'utf8')) as { guardedPaths: string[] };
    guardedPaths = own.guardedPaths;
    root = await mkdtemp(join(tmpdir(), 'usabl-guard-case-time-'));
    await git(root, ['init', '--initial-branch=main']);
    await git(root, ['config', 'user.name', 'Test User']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await write(root, 'usabl.config.json', JSON.stringify({ guardedPaths }));
    await write(root, 'src/trust/guard.ts');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'base']);
    for (let p = 0; p < PACKAGES; p += 1) {
      await mkdir(join(root, `node_modules/pkg${String(p)}/lib`), { recursive: true });
      await Promise.all(
        Array.from({ length: FILES_PER_PACKAGE }, (_, f) => writeFile(join(root, `node_modules/pkg${String(p)}/lib/file${String(f)}.js`), 'x\n')),
      );
    }
  }, SETUP_MS);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  }, SETUP_MS);

  async function expand(platform: NodeJS.Platform): Promise<{ paths: string[]; ms: number; heap: number }> {
    const deps: Deps = { ...makeFakeDeps(), git: makeGitReader({ cwd: root }), fs: makeFsGlob({ cwd: root, platform }) };
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();
    const paths = await expandConfigGuardedSet(deps, { guardedPaths });
    return { paths, ms: performance.now() - start, heap: process.memoryUsage().heapUsed - heapBefore };
  }

  it('costs about what it costs on Linux and finds the same files', async () => {
    const linux = await expand('linux');
    for (const platform of ['darwin', 'win32'] as const) {
      const folded = await expand(platform);
      if (process.env['GUARD_CASE_TIME_REPORT'] === '1') console.log(platform, Math.round(folded.ms), 'ms', Math.round(folded.heap / 1e6), 'MB; linux', Math.round(linux.ms), 'ms');
      expect(folded.paths, platform).toEqual(linux.paths);
      expect(folded.ms, platform).toBeLessThan(QUICK_MS);
      expect(folded.heap, platform).toBeLessThan(HEAP_GROWTH_BYTES);
    }
    expect(linux.paths).toContain('usabl.config.json');
    expect(linux.paths).toContain('src/trust/guard.ts');
  });
});
