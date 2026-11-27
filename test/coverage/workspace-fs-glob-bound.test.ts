/**
 * A workspaces pattern is written in the working tree with no code owner, so it can hold syntax
 * Node's fs.glob takes a very long time to match. The adapter does not run such a pattern, and the
 * workspace packages are then unknown: every changed file that may sit in one is a gap, never a
 * file outside every package. These tests use a real temporary folder and the real adapter.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFsGlob } from '../../src/deps/fs.js';

const config: UsablConfig = {
  appBaseUrl: 'http://localhost:5173',
  uiFileGlobs: ['packages/admin/src/**/*.tsx'],
  discovery: { routerFile: 'packages/admin/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

const manifest = (name: string, dependencies: Record<string, string> = {}): string => JSON.stringify({ name, dependencies });

function tree(workspaces: string[]): Record<string, string> {
  return {
    'package.json': JSON.stringify({ private: true, workspaces }),
    'packages/admin/package.json': manifest('@mono/admin', { '@mono/ui': 'workspace:*' }),
    'packages/admin/src/App.tsx': 'export function App() { return null; }',
    'packages/ui/package.json': manifest('@mono/ui'),
    'packages/ui/src/Button.tsx': 'export function Button() { return null; }',
  };
}

describe('a workspaces pattern past the glob bound', { timeout: 30_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function coverageFor(workspaces: string[], changed: string): Promise<Awaited<ReturnType<typeof computeCoverage>>> {
    root = await mkdtemp(join(tmpdir(), 'usabl-ws-bound-'));
    for (const [file, text] of Object.entries(tree(workspaces))) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    }
    return computeCoverage(makeFsGlob({ cwd: root }), config, [changed]);
  }

  it('makes every changed file outside uiFileGlobs a gap that names the pattern', async () => {
    const coverage = await coverageFor(['packages/admin', 'packages/+(ui|web)'], 'packages/ui/src/Button.tsx');
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.unresolvedFiles).toEqual(['packages/ui/src/Button.tsx']);
    const reason = coverage.gaps[0]?.reason ?? '';
    expect(reason).toContain('could not read the workspace packages');
    expect(reason).toContain('packages/+(ui|web)');
    expect(reason).toContain('extglob');
  });

  it('is a gap for a file no listed package holds, too, since the packages are unknown', async () => {
    const coverage = await coverageFor(['packages/admin', 'packages/+(ui|web)'], 'tools/x.ts');
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.unresolvedFiles).toEqual(['tools/x.ts']);
  });

  // `{,zz}/**` expands to `/**`, which Node walks from the root of the machine.
  for (const pattern of ['{,zz}/**', '{/,a}/**', '/packages/*', '..\\outside\\*', `${'..\\'.repeat(10)}**`, '{..,packages/*}', 'packages/{ui,**/..}', '{*a*,**/a,*}/{b,*a*/**,**/..}']) {
    it(`makes ${pattern}, which usabl does not run, a gap and never walks it`, async () => {
      const start = performance.now();
      const coverage = await coverageFor(['packages/admin', pattern], 'packages/ui/src/Button.tsx');
      const ms = performance.now() - start;
      expect(coverage.unresolvedFiles).toEqual(['packages/ui/src/Button.tsx']);
      const reason = coverage.gaps[0]?.reason ?? '';
      expect(reason).toContain('could not read the workspace packages');
      expect(reason).toContain(pattern);
      expect(ms).toBeLessThan(3000);
    });
  }

  it('reads a pattern inside the bound as before', async () => {
    const coverage = await coverageFor(['packages/admin', 'packages/[u]*'], 'packages/ui/src/Button.tsx');
    expect(coverage.gaps[0]?.reason ?? '').toContain('@mono/ui in packages/ui');
  });
});
