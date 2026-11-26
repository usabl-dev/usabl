/**
 * The workspaces list is written in the working tree with no code owner, so its size is agent
 * input. Each entry over 1,024 characters, and a list of more than 1,000 entries, is past the
 * bound: the root reads as one usabl cannot read, and no entry is cleaned or globbed. These tests
 * use a real temporary folder and the real adapter.
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

describe('the size of the workspaces list', { timeout: 30_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function coverageFor(workspaces: string[], changed: string): Promise<Awaited<ReturnType<typeof computeCoverage>>> {
    root = await mkdtemp(join(tmpdir(), 'usabl-ws-limits-'));
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ private: true, workspaces }),
      'packages/admin/package.json': manifest('@mono/admin', { '@mono/ui': 'workspace:*' }),
      'packages/admin/src/App.tsx': 'export function App() { return null; }',
      'packages/ui/package.json': manifest('@mono/ui'),
      'packages/ui/src/Button.tsx': 'export function Button() { return null; }',
    };
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    }
    return computeCoverage(makeFsGlob({ cwd: root }), config, [changed]);
  }

  it('makes an entry over 1,024 characters a gap', async () => {
    const coverage = await coverageFor(['packages/admin', `packages/${'u'.repeat(1100)}`], 'packages/ui/src/Button.tsx');
    expect(coverage.unresolvedFiles).toEqual(['packages/ui/src/Button.tsx']);
    const reason = coverage.gaps[0]?.reason ?? '';
    expect(reason).toContain('could not read the workspace packages');
    expect(reason).toContain('1,024 characters');
  });

  it('makes a list of more than 1,000 entries a gap', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `packages/p${i}`);
    const coverage = await coverageFor(many, 'packages/ui/src/Button.tsx');
    expect(coverage.unresolvedFiles).toEqual(['packages/ui/src/Button.tsx']);
    expect(coverage.gaps[0]?.reason ?? '').toContain('1,000 entries');
  });

  it('reads long runs of slashes quickly and makes them a gap', async () => {
    const long = Array.from({ length: 4 }, (_, i) => `p${i}${'/'.repeat(60_000)}x`);
    const start = performance.now();
    const coverage = await coverageFor(['packages/admin', ...long], 'packages/ui/src/Button.tsx');
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(coverage.unresolvedFiles).toEqual(['packages/ui/src/Button.tsx']);
  });

  it('still lists the package an entry with trailing slashes names', async () => {
    const coverage = await coverageFor(['packages/admin', './packages/ui///'], 'packages/ui/src/Button.tsx');
    expect(coverage.gaps[0]?.reason ?? '').toContain('@mono/ui in packages/ui');
  });
});
