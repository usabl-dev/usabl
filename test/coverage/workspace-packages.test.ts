import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FsGlob, UsablConfig } from '../../src/contracts/index.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { run } from '../../src/run.js';

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

// The app declares no dependency on ui by its name. Each case links it another way.
function undeclaredTree(adminManifest: Record<string, unknown>, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...workspaceTree(),
    'packages/admin/package.json': JSON.stringify({ name: '@mono/admin', ...adminManifest }),
    ...extra,
  };
}

describe('a workspace dependency declared under another name', () => {
  for (const [form, value] of [
    ['pnpm workspace alias', 'workspace:@mono/ui@*'],
    ['pnpm workspace alias with no range', 'workspace:@mono/ui'],
    ['npm alias', 'npm:@mono/ui@^1.0.0'],
    ['file path', 'file:../ui'],
    ['link path', 'link:../ui'],
    ['portal path', 'portal:../ui/'],
    ['pnpm workspace path', 'workspace:../ui'],
  ] as const) {
    it(`counts a ${form} (${value})`, async () => {
      const files = undeclaredTree({ dependencies: { 'ui-kit': value } });
      const coverage = await computeCoverage(fsOf(files), adminConfig, ['packages/ui/src/Button.tsx']);
      expect(coverage.nothingToCheck).toBe(false);
      expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
    });
  }

  it('does not count a path that names another folder', async () => {
    const files = undeclaredTree({ dependencies: { 'ui-kit': 'file:../web' } });
    const coverage = await computeCoverage(fsOf(files), adminConfig, ['packages/ui/src/Button.tsx']);
    expect(coverage.gaps).toEqual([]);
  });
});

describe('a workspace package the app imports without declaring it', () => {
  it('counts a bare import of the package, as hoisting lets it resolve', async () => {
    const files = undeclaredTree({}, {
      'packages/admin/src/App.tsx': "import {\n  Button,\n} from '@mono/ui';\nexport function App() { return Button; }",
    });
    const coverage = await computeCoverage(fsOf(files), adminConfig, ['packages/ui/src/Button.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
  });

  it('counts an import of a subpath of the package from any source file in the app', async () => {
    const files = undeclaredTree({}, { 'packages/admin/src/hooks/useTheme.ts': "export { theme } from '@mono/ui/theme';" });
    const coverage = await computeCoverage(fsOf(files), adminConfig, ['packages/ui/src/Button.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
  });

  it('does not count a package whose name only starts the same way', async () => {
    const files = undeclaredTree({}, { 'packages/admin/src/App.tsx': "import { x } from '@mono/ui-extra';" });
    const coverage = await computeCoverage(fsOf(files), adminConfig, ['packages/ui/src/Button.tsx']);
    expect(coverage.gaps).toEqual([]);
  });

  it('counts a tsconfig paths alias in the app folder that points into the package', async () => {
    const files = undeclaredTree({}, {
      'packages/admin/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@ui/*': ['../ui/src/*'] } } }),
    });
    const coverage = await computeCoverage(fsOf(files), adminConfig, ['packages/ui/src/Button.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
  });

  it('counts a Vite alias in the app folder that points into the package', async () => {
    const files = undeclaredTree({}, {
      'packages/admin/vite.config.ts': "export default { resolve: { alias: { '@ui': '../ui/src' } } };",
    });
    const coverage = await computeCoverage(fsOf(files), adminConfig, ['packages/ui/src/Button.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
  });

  it('counts a tsconfig paths alias at the repository root that points into the package', async () => {
    const files = undeclaredTree({}, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@ui/*': ['packages/ui/src/*'] } } }),
    });
    const coverage = await computeCoverage(fsOf(files), adminConfig, ['packages/ui/src/Button.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
  });
});

describe('a workspace root usabl cannot read', () => {
  const changed = ['packages/ui/src/Button.tsx', 'packages/admin/src/App.test.tsx', 'docs/notes.md', 'scripts/build.ts'];

  it('makes every changed file a gap that names an unparsable root package.json', async () => {
    const files = { ...workspaceTree(), 'package.json': '{ "workspaces": [' };
    const coverage = await computeCoverage(fsOf(files), adminConfig, changed);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx', 'scripts/build.ts']);
    for (const gap of coverage.gaps) {
      expect(gap.state).toBe('not-covered');
      expect(gap.reason).toContain('package.json');
    }
  });

  it('makes every changed file a gap when the workspaces field has the wrong type', async () => {
    const files = { ...workspaceTree(), 'package.json': JSON.stringify({ workspaces: 'packages/*' }) };
    const coverage = await computeCoverage(fsOf(files), adminConfig, changed);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx', 'scripts/build.ts']);
  });

  it('makes every changed file a gap that names an unparsable pnpm-workspace.yaml', async () => {
    const files = { ...workspaceTree({ private: true }), 'pnpm-workspace.yaml': 'packages: [unclosed\n' };
    const coverage = await computeCoverage(fsOf(files), adminConfig, changed);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx', 'scripts/build.ts']);
    expect(coverage.gaps[0]?.reason).toContain('pnpm-workspace.yaml');
  });

  it('makes every changed file a gap when pnpm-workspace.yaml lists packages in the wrong shape', async () => {
    const files = { ...workspaceTree({ private: true }), 'pnpm-workspace.yaml': 'packages: packages/*\n' };
    const coverage = await computeCoverage(fsOf(files), adminConfig, ['packages/ui/src/Button.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
    expect(coverage.gaps[0]?.reason).toContain('pnpm-workspace.yaml');
  });
});

describe('workspace layouts', () => {
  it("reads Bun's workspaces list", async () => {
    // Bun reads the same "workspaces" array npm does, with its own glob forms.
    const files = { ...workspaceTree({ name: 'mono', workspaces: ['packages/**'] }) };
    const coverage = await computeCoverage(fsOf(files), adminConfig, ['packages/ui/src/Button.tsx', 'packages/web/src/Home.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
  });

  it('gives a file in a nested package to the nearest package', async () => {
    const files = {
      ...workspaceTree({ private: true, workspaces: ['packages/*', 'packages/ui/plugins/*'] }),
      'packages/ui/plugins/charts/package.json': manifest('@mono/charts'),
      'packages/ui/plugins/charts/src/Pie.tsx': '',
      'packages/ui/plugins/maps/package.json': manifest('@mono/maps'),
      'packages/ui/plugins/maps/src/Map.tsx': '',
      'packages/ui/package.json': manifest('@mono/ui', { '@mono/charts': 'workspace:*' }),
    };
    const coverage = await computeCoverage(fsOf(files), adminConfig, [
      'packages/ui/plugins/charts/src/Pie.tsx',
      'packages/ui/plugins/maps/src/Map.tsx',
    ]);
    // maps sits inside ui's folder, but it is its own package, and nothing the app uses depends on it.
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/plugins/charts/src/Pie.tsx']);
    expect(coverage.gaps[0]?.reason).toContain('@mono/charts in packages/ui/plugins/charts');
  });
});

describe('workspace patterns that leave the repository', () => {
  // A memory fs whose glob returns whatever a pattern would reach on a real disk, outside the
  // repository too, and that records every file read.
  function escapingFs(files: Record<string, string>, outside: Record<string, string[]>): { fs: FsGlob; reads: string[]; globs: string[] } {
    const base = fsOf(files);
    const reads: string[] = [];
    const globs: string[] = [];
    return {
      reads,
      globs,
      fs: {
        readFile: async (file) => {
          reads.push(file);
          return base.readFile(file);
        },
        glob: async (patterns) => {
          globs.push(...patterns);
          const found = await base.glob(patterns);
          return [...found, ...patterns.flatMap((pattern) => outside[pattern] ?? [])];
        },
      },
    };
  }

  it('drops a glob result that is absolute or above the repository', async () => {
    const { fs, reads } = escapingFs(workspaceTree(), {
      'packages/*/package.json': ['../package.json', '../../other/package.json', '/etc/app/package.json'],
    });
    const coverage = await computeCoverage(fs, adminConfig, ['packages/ui/src/Button.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
    expect(reads.filter((file) => file.startsWith('../') || file.startsWith('/'))).toEqual([]);
  });

  it('refuses a brace pattern that holds ..', async () => {
    const { fs, globs, reads } = escapingFs(
      { ...workspaceTree({ private: true, workspaces: ['{..,packages/*}'] }) },
      { '{..,packages/*}/package.json': ['../package.json'] },
    );
    await computeCoverage(fs, adminConfig, ['packages/ui/src/Button.tsx']);
    expect(globs.filter((pattern) => pattern.includes('..'))).toEqual([]);
    expect(reads.filter((file) => file.startsWith('../'))).toEqual([]);
  });

  it('never reads above the repository on a real disk', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'usabl-ws-'));
    try {
      const repo = path.join(parent, 'repo');
      const tree = { ...workspaceTree({ private: true, workspaces: ['{..,packages/*}', '{/etc,packages/*}'] }) };
      for (const [file, text] of Object.entries(tree)) {
        await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
        await writeFile(path.join(repo, file), text);
      }
      await writeFile(path.join(parent, 'package.json'), manifest('@mono/outside'));
      const disk = makeFsGlob({ cwd: repo });
      const reads: string[] = [];
      const logged: FsGlob = {
        readFile: async (file) => {
          reads.push(file);
          return disk.readFile(file);
        },
        glob: (patterns) => disk.glob(patterns),
      };
      await computeCoverage(logged, adminConfig, ['packages/ui/src/Button.tsx']);
      expect(reads.filter((file) => file.startsWith('../') || path.isAbsolute(file))).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('the workspace as the trusted ref has it', () => {
  const trustedOf = (files: Record<string, string>) => async (file: string): Promise<string | null> => files[file] ?? null;

  it('keeps the gap when the change removes workspaces from the root package.json', async () => {
    const before = workspaceTree();
    const after = { ...before, 'package.json': JSON.stringify({ private: true }) };
    const coverage = await computeCoverage(fsOf(after), adminConfig, ['packages/ui/src/Button.tsx'], null, trustedOf(before));
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
  });

  it('keeps the gap when the change removes the app\'s dependency on the package', async () => {
    const before = workspaceTree();
    const after = { ...before, 'packages/admin/package.json': manifest('@mono/admin') };
    const coverage = await computeCoverage(fsOf(after), adminConfig, ['packages/ui/src/Button.tsx'], null, trustedOf(before));
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
  });

  it('adds nothing for a package the trusted ref does not have', async () => {
    const coverage = await computeCoverage(fsOf(workspaceTree()), adminConfig, ['packages/web/src/Home.tsx'], null, trustedOf({}));
    expect(coverage).toMatchObject({ nothingToCheck: true, gaps: [] });
  });

  it('makes every changed file a gap when the trusted root package.json does not parse', async () => {
    const coverage = await computeCoverage(fsOf(workspaceTree()), adminConfig, ['scripts/build.ts'], null, trustedOf({ 'package.json': '{' }));
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['scripts/build.ts']);
    expect(coverage.gaps[0]?.reason).toContain('package.json at the trusted ref');
  });
});

describe('a run on a change that removes workspaces from the root package.json', () => {
  it('reads the workspace at the trusted ref, so the change is not idle', async () => {
    const before = workspaceTree();
    const after = { ...before, 'package.json': JSON.stringify({ private: true }) };
    const deps = makeFakeDeps({ files: after, headContents: before });
    const result = await run(deps, adminConfig, { changedFiles: ['package.json', 'packages/ui/src/Button.tsx'] });
    expect(result.coverage.nothingToCheck).toBe(false);
    expect(result.coverage.gaps.map((gap) => gap.ref)).toContain('packages/ui/src/Button.tsx');
  });
});
