import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FsGlob, UsablConfig } from '../../src/contracts/index.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

const fsOf = (files: Record<string, string>): FsGlob => makeFakeDeps({ files }).fs;

// The real fixture: packages/admin depends on @mono/shared, and packages/web depends on nothing in
// the workspace.
const fixtureFs = (): FsGlob => makeFsGlob({ cwd: fileURLToPath(new URL('../../fixtures/init/monorepo', import.meta.url)) });

// What usabl init --app packages/admin drafts, in the parts the planner reads.
const adminConfig: UsablConfig = {
  appBaseUrl: 'http://localhost:5173',
  uiFileGlobs: ['packages/admin/src/**/*.tsx'],
  discovery: { routerFile: 'packages/admin/src/App.tsx', wideBlastGlobs: ['packages/admin/src/main.tsx'] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

const manifest = (name: string, dependencies: Record<string, string> = {}): string => JSON.stringify({ name, dependencies });

// A memory tree: admin depends on ui, ui depends on tokens, and web stands alone.
function workspaceTree(rootManifest: Record<string, unknown> = { private: true, workspaces: ['packages/*'] }): Record<string, string> {
  return {
    'package.json': JSON.stringify(rootManifest),
    'packages/admin/package.json': manifest('@mono/admin', { '@mono/ui': 'workspace:*' }),
    'packages/admin/src/App.tsx': 'export function App() { return null; }',
    'packages/ui/package.json': manifest('@mono/ui', { '@mono/tokens': '^1.0.0' }),
    'packages/ui/src/Button.tsx': 'export function Button() { return null; }',
    'packages/tokens/package.json': manifest('@mono/tokens'),
    'packages/tokens/src/colors.ts': 'export const ink = "#000";',
    'packages/web/package.json': manifest('@mono/web'),
    'packages/web/src/Home.tsx': 'export function Home() { return null; }',
  };
}

describe('changes in workspace packages the app depends on', () => {
  it('records a gap that names the package and the fix for a change in packages/shared', async () => {
    const coverage = await computeCoverage(fixtureFs(), adminConfig, ['packages/shared/src/Button.tsx']);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.affected).toEqual([]);
    expect(coverage.unresolvedFiles).toEqual(['packages/shared/src/Button.tsx']);
    expect(coverage.gaps).toHaveLength(1);
    const gap = coverage.gaps[0];
    expect(gap?.ref).toBe('packages/shared/src/Button.tsx');
    expect(gap?.state).toBe('not-covered');
    expect(gap?.reason).toContain('@mono/shared in packages/shared');
    expect(gap?.reason).toContain('which packages/admin depends on');
    expect(gap?.reason).toContain('add the package\'s source to uiFileGlobs, such as packages/shared/src/**/*.tsx');
    expect(gap?.reason).toContain('files of each surface');
  });

  it('still reads a change in packages/web, which admin does not depend on, as nothing to check', async () => {
    const coverage = await computeCoverage(fixtureFs(), adminConfig, ['packages/web/src/pages/Home.tsx']);
    expect(coverage).toMatchObject({ nothingToCheck: true, affected: [], unresolvedFiles: [], gaps: [] });
  });

  it('keeps the gap beside the screens a change in the app itself maps to', async () => {
    const coverage = await computeCoverage(fixtureFs(), adminConfig, [
      'packages/admin/src/main.tsx',
      'packages/shared/src/Button.tsx',
    ]);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.affected.length).toBeGreaterThan(0);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/shared/src/Button.tsx']);
  });

  it('follows the dependency through another workspace package', async () => {
    const coverage = await computeCoverage(fsOf(workspaceTree()), adminConfig, ['packages/tokens/src/colors.ts']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/tokens/src/colors.ts']);
    expect(coverage.gaps[0]?.reason).toContain('@mono/tokens in packages/tokens');
  });

  it('reads every workspace pattern, not only packages/* and apps/*', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ private: true, workspaces: { packages: ['frontend/console', 'libs/*', '!libs/legacy'] } }),
      'frontend/console/package.json': manifest('console', { '@corp/widgets': '*', '@corp/legacy': '*' }),
      'frontend/console/src/App.tsx': '',
      'libs/widgets/package.json': manifest('@corp/widgets'),
      'libs/widgets/lib/Card.jsx': '',
      'libs/legacy/package.json': manifest('@corp/legacy'),
      'libs/legacy/src/Old.tsx': '',
    };
    const config: UsablConfig = {
      ...adminConfig,
      uiFileGlobs: ['frontend/console/src/**/*.tsx'],
      discovery: { routerFile: 'frontend/console/src/App.tsx', wideBlastGlobs: [] },
    };
    const coverage = await computeCoverage(fsOf(files), config, ['libs/widgets/lib/Card.jsx', 'libs/legacy/src/Old.tsx']);
    // libs/legacy is excluded from the workspace, so it is not a workspace package the app links.
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['libs/widgets/lib/Card.jsx']);
  });

  it('reads the packages list of pnpm-workspace.yaml', async () => {
    const files = { ...workspaceTree({ private: true }), 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n" };
    const coverage = await computeCoverage(fsOf(files), adminConfig, ['packages/ui/src/Button.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
  });

  it('counts a package whose package.json cannot be read as one the app depends on', async () => {
    const files = { ...workspaceTree(), 'packages/web/package.json': '{ not json' };
    const coverage = await computeCoverage(fsOf(files), adminConfig, ['packages/web/src/Home.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/web/src/Home.tsx']);
    expect(coverage.gaps[0]?.reason).toContain('could not be read');
  });

  it('reads tests and Markdown in a dependency as nothing to check', async () => {
    const coverage = await computeCoverage(fsOf(workspaceTree()), adminConfig, [
      'packages/ui/src/Button.test.tsx',
      'packages/ui/README.md',
    ]);
    expect(coverage).toMatchObject({ nothingToCheck: true, gaps: [] });
  });

  it('leaves a root app with no workspaces as it was', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18.3.0' } }),
      'src/router.tsx': '',
      'lib/helpers.ts': '',
    };
    const config: UsablConfig = {
      ...adminConfig,
      uiFileGlobs: ['src/**/*.tsx'],
      discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: [] },
    };
    const coverage = await computeCoverage(fsOf(files), config, ['lib/helpers.ts', 'README.md']);
    expect(coverage).toEqual({
      changedFiles: ['lib/helpers.ts', 'README.md'],
      affected: [],
      unresolvedFiles: [],
      gaps: [],
      nothingToCheck: true,
    });
  });

  it('counts the dependencies of a root app that has workspaces', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'app', workspaces: ['packages/*'], dependencies: { '@mono/ui': '*' } }),
      'src/router.tsx': '',
      'packages/ui/package.json': manifest('@mono/ui'),
      'packages/ui/src/Button.tsx': '',
      'packages/web/package.json': manifest('@mono/web'),
      'packages/web/src/Home.tsx': '',
    };
    const config: UsablConfig = {
      ...adminConfig,
      uiFileGlobs: ['src/**/*.tsx'],
      discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: [] },
    };
    const coverage = await computeCoverage(fsOf(files), config, ['packages/ui/src/Button.tsx', 'packages/web/src/Home.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
    expect(coverage.gaps[0]?.reason).toContain('the app at the repository root');
  });
});
