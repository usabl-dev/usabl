import { describe, it, expect } from 'vitest';
import {
  aliasConfigDirs,
  loadAliasConfig,
  loadAppAliasConfig,
  resolveAliasSpecifier,
  resolveAliasSpecifierEachWay,
} from '../../src/coverage/alias-config.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

const fsOf = (files: Record<string, string>) => makeFakeDeps({ files }).fs;

describe('loadAliasConfig', () => {
  it('invents no mappings when no config files exist', async () => {
    // No ~/ -> ./ default. A tilde import with no config stays unresolved and disclosed, not
    // silently attributed to the project root.
    const config = await loadAliasConfig(fsOf({}));
    expect(config.mappings).toEqual([]);
    expect(config.hasAliasConfig).toBe(false);
  });

  it('reads tsconfig paths with @/* wildcard', async () => {
    const config = await loadAliasConfig(
      fsOf({
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@/*': ['src/*'] },
          },
        }),
      }),
    );
    expect(config.hasAliasConfig).toBe(true);
    expect(config.mappings).toContainEqual({ prefix: '@/', target: 'src/' });
  });

  it('reads tsconfig.app.json when present', async () => {
    const config = await loadAliasConfig(
      fsOf({
        'tsconfig.app.json': JSON.stringify({
          compilerOptions: {
            paths: { '@/*': ['app/src/*'] },
          },
        }),
      }),
    );
    expect(config.mappings).toContainEqual({ prefix: '@/', target: 'app/src/' });
  });

  it('reads vite resolve.alias object form', async () => {
    const config = await loadAliasConfig(
      fsOf({
        'vite.config.ts': `
import { defineConfig } from 'vite'
export default defineConfig({
  resolve: {
    alias: {
      '@': './src',
    },
  },
})
`,
      }),
    );
    expect(config.mappings).toContainEqual({ prefix: '@/', target: 'src/' });
  });

  it('reads a vite resolve.alias key that is not quoted', async () => {
    const config = await loadAliasConfig(
      fsOf({ 'vite.config.ts': "export default { resolve: { alias: { tests: './src/tests', $lib: '/src/lib' } } };" }),
    );
    expect(config.mappings).toEqual([
      { prefix: 'tests/', target: 'src/tests/' },
      { prefix: '$lib/', target: 'src/lib/' },
    ]);
  });

  it('reads vite resolve.alias array form', async () => {
    const config = await loadAliasConfig(
      fsOf({
        'vite.config.ts': `
export default {
  resolve: {
    alias: [
      { find: '@', replacement: './src' },
    ],
  },
}
`,
      }),
    );
    expect(config.mappings).toContainEqual({ prefix: '@/', target: 'src/' });
  });

  it('resolves path.resolve(__dirname, "./src") relative to vite config directory', async () => {
    const config = await loadAliasConfig(
      fsOf({
        'vite.config.ts': `
export default {
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
}
`,
      }),
    );
    expect(config.mappings).toContainEqual({ prefix: '@/', target: 'src/' });
  });

  it('vite alias wins over tsconfig for the same prefix', async () => {
    const config = await loadAliasConfig(
      fsOf({
        'tsconfig.json': JSON.stringify({
          compilerOptions: { paths: { '@/*': ['legacy/*'] } },
        }),
        'vite.config.ts': `
export default { resolve: { alias: { '@': './src' } } }
`,
      }),
    );
    const atMapping = config.mappings.find((m) => m.prefix === '@/');
    expect(atMapping?.target).toBe('src/');
  });

  it('does not invent a ~/ mapping when no config declares one', async () => {
    const config = await loadAliasConfig(fsOf({}));
    expect(config.mappings.some((m) => m.prefix === '~/')).toBe(false);
  });

  it('reads resolve.alias, not a decoy alias elsewhere in the config', async () => {
    // A bare alias in a plugin option must not be read as resolve.alias. Reading the decoy would
    // attribute the wrong file.
    const config = await loadAliasConfig(
      fsOf({
        'vite.config.ts': `
export default {
  plugins: [somePlugin({ alias: { '@': './src/decoy' } })],
  resolve: { alias: { '@': './src' } },
}
`,
      }),
    );
    expect(config.mappings.find((m) => m.prefix === '@/')?.target).toBe('src/');
  });
});

// The configs of one folder give that folder's aliases, with targets written relative to the
// repository root. An app's set comes from the nearest tsconfig and the nearest Vite config, found
// on their own, and the root set is read beside it.
describe('loadAliasConfig for an app folder', () => {
  it('reads only the tsconfig and Vite config of the folder it is given', async () => {
    const config = await loadAliasConfig(
      fsOf({
        'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '~/*': ['root/*'] } } }),
        'packages/admin/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
        'packages/admin/vite.config.ts': `export default { resolve: { alias: { '#lib': '/lib' } } };`,
      }),
      'packages/admin',
    );
    expect(config.mappings).toContainEqual({ prefix: '@/', target: 'packages/admin/src/' });
    // A leading slash in a Vite alias is the Vite root, which is the app folder.
    expect(config.mappings).toContainEqual({ prefix: '#lib/', target: 'packages/admin/lib/' });
    expect(config.mappings.some((mapping) => mapping.target.startsWith('root'))).toBe(false);
  });

  it('finds the tsconfig folder and the Vite config folder on their own, climbing from a file', async () => {
    const fs = fsOf({
      'tsconfig.json': '{}',
      'packages/admin/tsconfig.json': '{}',
      'packages/admin/src/App.tsx': '',
    });
    expect(await aliasConfigDirs(fs, 'packages/admin/src/App.tsx')).toEqual({ tsconfigDir: 'packages/admin', viteDir: '' });
    expect(await aliasConfigDirs(fs, 'src/App.tsx')).toEqual({ tsconfigDir: '', viteDir: '' });
    expect(await aliasConfigDirs(fsOf({ 'tsconfig.json': '{}', 'apps/web/vite.config.mts': '' }), 'apps/web/src/main.tsx')).toEqual({
      tsconfigDir: '',
      viteDir: 'apps/web',
    });
  });

  it('reads the app set and the root set, and keeps the root set only when it differs', async () => {
    const appOnlyVite = await loadAppAliasConfig(
      fsOf({
        'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['apps/web/src/*'] } } }),
        'apps/web/vite.config.ts': 'export default {};',
      }),
      'apps/web/src/router.tsx',
    );
    expect(appOnlyVite.mappings).toEqual([{ prefix: '@/', target: 'apps/web/src/' }]);
    expect(appOnlyVite.otherSources).toBeUndefined();

    const disagreeing = await loadAppAliasConfig(
      fsOf({
        'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['legacy/*'] } } }),
        'apps/web/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      }),
      'apps/web/src/router.tsx',
    );
    expect(disagreeing.mappings).toEqual([{ prefix: '@/', target: 'apps/web/src/' }]);
    expect(disagreeing.otherSources).toEqual([[{ prefix: '@/', target: 'legacy/' }]]);
    expect(resolveAliasSpecifierEachWay('@/components/Card', disagreeing)).toEqual([
      'apps/web/src/components/Card',
      'legacy/components/Card',
    ]);
    expect(resolveAliasSpecifierEachWay('~/x', disagreeing)).toEqual([]);
  });
});

describe('loadAliasConfig with extends and single-file paths', () => {
  it('reads paths from the config a tsconfig extends, resolved from that config', async () => {
    const config = await loadAliasConfig(
      fsOf({
        'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['packages/shared/src/*'], '@/*': ['packages/admin/src/*'] } } }),
        'packages/admin/tsconfig.json': JSON.stringify({ extends: '../../tsconfig.base' }),
      }),
      'packages/admin',
    );
    expect(config.hasAliasConfig).toBe(true);
    expect(config.mappings).toContainEqual({ prefix: '@/', target: 'packages/admin/src/' });
  });

  it('reads an extends list, where a later config wins, and lets the child paths replace the parent ones', async () => {
    const fs = fsOf({
      'a.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['from-a/*'] } } }),
      'b.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['from-b/*'] } } }),
      'tsconfig.json': JSON.stringify({ extends: ['./a.json', './b.json'] }),
    });
    expect((await loadAliasConfig(fs)).mappings).toEqual([{ prefix: '@/', target: 'from-b/' }]);
    const child = fsOf({
      'base.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['base/*'] } } }),
      'tsconfig.json': JSON.stringify({ extends: './base.json', compilerOptions: { paths: { '~/*': ['own/*'] } } }),
    });
    expect((await loadAliasConfig(child)).mappings).toEqual([{ prefix: '~/', target: 'own/' }]);
  });

  it('resolves inherited paths from the baseUrl the child sets', async () => {
    const config = await loadAliasConfig(
      fsOf({
        'tsconfig.base.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
        'packages/admin/tsconfig.json': JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { baseUrl: '.' } }),
      }),
      'packages/admin',
    );
    expect(config.mappings).toEqual([{ prefix: '@/', target: 'packages/admin/src/' }]);
  });

  it('stops on an extends cycle and on a config it cannot read', async () => {
    const fs = fsOf({
      'a.json': JSON.stringify({ extends: './tsconfig.json' }),
      'tsconfig.json': JSON.stringify({ extends: './a.json' }),
    });
    expect((await loadAliasConfig(fs)).mappings).toEqual([]);
    const missing = fsOf({ 'tsconfig.json': JSON.stringify({ extends: './gone.json', compilerOptions: { paths: { '@/*': ['src/*'] } } }) });
    expect((await loadAliasConfig(missing)).mappings).toEqual([{ prefix: '@/', target: 'src/' }]);
  });

  it('reads a single-file path, which matches only the exact specifier', async () => {
    const config = await loadAliasConfig(
      fsOf({
        'tsconfig.json': JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@/theme': ['src/styles/theme.ts'], '@/*': ['src/*'] } },
        }),
      }),
    );
    expect(resolveAliasSpecifier('@/theme', config.mappings)).toBe('src/styles/theme.ts');
    expect(resolveAliasSpecifier('@/theme/dark', config.mappings)).toBe('src/theme/dark');
    expect(resolveAliasSpecifier('@/Home', config.mappings)).toBe('src/Home');
  });
});

describe('resolveAliasSpecifier', () => {
  const mappings = [{ prefix: '@/', target: 'src/' }];

  it('resolves @/components/Foo to src/components/Foo', () => {
    expect(resolveAliasSpecifier('@/components/Foo', mappings)).toBe('src/components/Foo');
  });

  it('resolves @/ alone to src/', () => {
    expect(resolveAliasSpecifier('@/index', mappings)).toBe('src/index');
  });

  it('returns null when no mapping matches', () => {
    expect(resolveAliasSpecifier('~/lib/utils', [{ prefix: '@/', target: 'src/' }])).toBeNull();
  });

  it('resolves in given order, first match wins (not by prefix length)', () => {
    // Order is the resolution rule. Vite applies aliases in declaration order, so a broad '@/'
    // declared first must win over a longer '@/features/' declared after it. Re-sorting by length
    // would resolve to a different file than the bundler, a false-coverage risk.
    const broadFirst = [
      { prefix: '@/', target: 'src/legacy/' },
      { prefix: '@/features/', target: 'src/features/' },
    ];
    expect(resolveAliasSpecifier('@/features/Home', broadFirst)).toBe('src/legacy/features/Home');
    const specificFirst = [
      { prefix: '@/features/', target: 'src/features/' },
      { prefix: '@/', target: 'src/legacy/' },
    ];
    expect(resolveAliasSpecifier('@/features/Home', specificFirst)).toBe('src/features/Home');
  });
});
