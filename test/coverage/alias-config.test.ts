import { describe, it, expect } from 'vitest';
import { loadAliasConfig, resolveAliasSpecifier } from '../../src/coverage/alias-config.js';
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
