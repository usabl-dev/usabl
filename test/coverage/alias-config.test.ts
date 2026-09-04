import { describe, it, expect } from 'vitest';
import { loadAliasConfig, resolveAliasSpecifier } from '../../src/coverage/alias-config.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

const fsOf = (files: Record<string, string>) => makeFakeDeps({ files }).fs;

describe('loadAliasConfig', () => {
  it('returns only the default ~/ mapping when no config files exist', async () => {
    const config = await loadAliasConfig(fsOf({}));
    expect(config.mappings).toEqual([{ prefix: '~/', target: './' }]);
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

  it('adds ~/ to project root when no explicit mapping exists', async () => {
    const config = await loadAliasConfig(fsOf({}));
    expect(config.mappings).toContainEqual({ prefix: '~/', target: './' });
  });
});

describe('resolveAliasSpecifier', () => {
  const mappings = [{ prefix: '@/', target: 'src/' }];

  it('resolves @/components/Foo to src/components/Foo', () => {
    expect(resolveAliasSpecifier('@/components/Foo', mappings, '.')).toBe('src/components/Foo');
  });

  it('resolves @/ alone to src/', () => {
    expect(resolveAliasSpecifier('@/index', mappings, '.')).toBe('src/index');
  });

  it('returns null when no mapping matches', () => {
    expect(resolveAliasSpecifier('~/lib/utils', [{ prefix: '@/', target: 'src/' }], '.')).toBeNull();
  });

  it('uses longest-prefix-first ordering', () => {
    const multi = [
      { prefix: '@/', target: 'src/' },
      { prefix: '@/features/', target: 'features/' },
    ];
    expect(resolveAliasSpecifier('@/features/Home', multi, '.')).toBe('features/Home');
  });
});
