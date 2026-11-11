import { describe, it, expect } from 'vitest';
import { buildImportGraph } from '../../src/coverage/import-graph.js';
import { loadAliasConfig } from '../../src/coverage/alias-config.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

const fsOf = (files: Record<string, string>) => makeFakeDeps({ files }).fs;

describe('buildImportGraph', () => {
  it('resolves a relative import by probing real extensions (.ts wins when .tsx absent)', async () => {
    const fs = fsOf({
      'src/ClustersPage.tsx': `import { ClusterTable } from './ClusterTable';`,
      'src/ClusterTable.ts': `export const ClusterTable = 1;`,
    });
    const graph = await buildImportGraph(fs, ['src/ClustersPage.tsx']);
    expect(graph.get('src/ClustersPage.tsx')).toContain('src/ClusterTable.ts');
  });

  it('records alias-unconfigured when no alias config exists', async () => {
    const fs = fsOf({ 'src/Page.tsx': `import { Foo } from '@/components/Foo';` });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.unresolvable).toContainEqual({
      importer: 'src/Page.tsx',
      specifier: '@/components/Foo',
      kind: 'alias-unconfigured',
    });
  });

  it('resolves @/ imports when tsconfig paths are present', async () => {
    const fs = fsOf({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
      'src/Page.tsx': `import { Foo } from '@/components/Foo';`,
      'src/components/Foo.tsx': `export const Foo = 1;`,
    });
    const aliasConfig = await loadAliasConfig(fs);
    const graph = await buildImportGraph(fs, ['src/Page.tsx'], aliasConfig);
    expect(graph.get('src/Page.tsx')).toContain('src/components/Foo.tsx');
    expect(graph.unresolvable).toEqual([]);
  });

  it('records file-not-found when alias resolves but no file exists', async () => {
    const fs = fsOf({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['src/*'] } },
      }),
      'src/Page.tsx': `import { Foo } from '@/components/Foo';`,
    });
    const aliasConfig = await loadAliasConfig(fs);
    const graph = await buildImportGraph(fs, ['src/Page.tsx'], aliasConfig);
    expect(graph.unresolvable).toContainEqual({
      importer: 'src/Page.tsx',
      specifier: '@/components/Foo',
      kind: 'file-not-found',
    });
  });

  it('links every candidate and discloses them when several candidate files exist', async () => {
    // With both Widget.js and Widget.tsx present, which one Vite loads depends on its
    // resolve.extensions order, which usabl does not parse. Picking one could attribute a change to
    // a screen that renders the other, so it links both, which can over-scan but never misses a
    // screen, and discloses the ambiguity, naming both files.
    const fs = fsOf({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
      'src/Page.tsx': `import { Widget } from '@/Widget';`,
      'src/Widget.js': `export const Widget = 1;`,
      'src/Widget.tsx': `export const Widget = 2;`,
    });
    const aliasConfig = await loadAliasConfig(fs);
    const graph = await buildImportGraph(fs, ['src/Page.tsx'], aliasConfig);
    expect(graph.get('src/Page.tsx')).toEqual(['src/Widget.js', 'src/Widget.tsx']);
    expect(graph.unresolvable).toContainEqual({
      importer: 'src/Page.tsx',
      specifier: '@/Widget',
      kind: 'ambiguous-candidates',
      candidates: ['src/Widget.js', 'src/Widget.tsx'],
    });
  });

  it('discloses a .vue sibling next to a .ts file and links both', async () => {
    // A project whose bundler resolves .vue can load Widget.vue for './Widget'. Probing only JS and
    // TS suffixes saw one candidate, Widget.ts, and attributed the import to it without a word.
    const fs = fsOf({
      'src/Page.tsx': `import { Widget } from './Widget';`,
      'src/Widget.ts': `export const Widget = 1;`,
      'src/Widget.vue': `<template><div /></template>`,
    });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.get('src/Page.tsx')).toEqual(['src/Widget.ts', 'src/Widget.vue']);
    expect(graph.unresolvable).toContainEqual({
      importer: 'src/Page.tsx',
      specifier: './Widget',
      kind: 'ambiguous-candidates',
      candidates: ['src/Widget.ts', 'src/Widget.vue'],
    });
  });

  it('discloses a .svelte sibling next to a .tsx file and links both', async () => {
    const fs = fsOf({
      'src/Page.tsx': `import Widget from './Widget';`,
      'src/Widget.tsx': `export default 1;`,
      'src/Widget.svelte': `<div />`,
    });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.get('src/Page.tsx')).toEqual(['src/Widget.svelte', 'src/Widget.tsx']);
    expect(graph.unresolvable).toContainEqual({
      importer: 'src/Page.tsx',
      specifier: './Widget',
      kind: 'ambiguous-candidates',
      candidates: ['src/Widget.svelte', 'src/Widget.tsx'],
    });
  });

  it('resolves an extensionless import to a lone .vue or .svelte file', async () => {
    const fs = fsOf({
      'src/Page.tsx': `import A from './A';\nimport B from './B';\nimport C from './widgets';`,
      'src/A.vue': `<template><div /></template>`,
      'src/B.svelte': `<div />`,
      'src/widgets/index.vue': `<template><div /></template>`,
    });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.get('src/Page.tsx')).toEqual(['src/A.vue', 'src/B.svelte', 'src/widgets/index.vue']);
    expect(graph.unresolvable).toEqual([]);
  });

  it('ignores scoped npm packages instead of disclosing them as unresolved aliases', async () => {
    const fs = fsOf({
      'src/Page.tsx': `import { Button } from '@patternfly/react-core';`,
    });
    const aliasConfig = await loadAliasConfig(fs);
    const graph = await buildImportGraph(fs, ['src/Page.tsx'], aliasConfig);
    expect(graph.unresolvable).toEqual([]);
  });

  it('records ~/ import as unresolvable when no config maps it', async () => {
    const fs = fsOf({
      'src/Page.tsx': `import { util } from '~/src/lib/util';`,
      'src/lib/util.ts': `export const util = 1;`,
    });
    const aliasConfig = await loadAliasConfig(fs);
    const graph = await buildImportGraph(fs, ['src/Page.tsx'], aliasConfig);
    // No invented ~/ -> ./ default, so this creates no coverage edge; it is disclosed instead of
    // silently attributing the file. Inventing the edge would be a false-coverage guess.
    expect(graph.get('src/Page.tsx')).not.toContain('src/lib/util.ts');
    expect(graph.unresolvable).toContainEqual({
      importer: 'src/Page.tsx',
      specifier: '~/src/lib/util',
      kind: 'alias-unconfigured',
    });
  });

  it('records a relative import with no existing candidate file as file-not-found', async () => {
    const fs = fsOf({ 'src/Page.tsx': `import { Gone } from './Gone';` });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.unresolvable).toContainEqual({
      importer: 'src/Page.tsx',
      specifier: './Gone',
      kind: 'file-not-found',
    });
  });

  it('resolves a dynamic import when the file exists', async () => {
    const fs = fsOf({
      'src/Page.tsx': `const module = await import('./Details');`,
      'src/Details.tsx': `export const Details = 1;`,
    });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.get('src/Page.tsx')).toContain('src/Details.tsx');
  });

  it('ignores bare package imports', async () => {
    const fs = fsOf({ 'src/Page.tsx': `import React from 'react';` });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.get('src/Page.tsx')).toEqual([]);
    expect(graph.unresolvable).toEqual([]);
  });

  it('probes directory index.tsx files', async () => {
    const fs = fsOf({
      'src/Page.tsx': `import { W } from './widgets';`,
      'src/widgets/index.tsx': `export const W = 1;`,
    });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.get('src/Page.tsx')).toContain('src/widgets/index.tsx');
  });

  it('uses the exact specifier path when an extension is present', async () => {
    const fs = fsOf({
      'src/ClustersPage.tsx': `import { ClusterTable } from './ClusterTable.ts';`,
      'src/ClusterTable.ts': `export const ClusterTable = 1;`,
    });
    const graph = await buildImportGraph(fs, ['src/ClustersPage.tsx']);
    expect(graph.get('src/ClustersPage.tsx')).toContain('src/ClusterTable.ts');
  });

  // TypeScript ESM code imports a .ts file under its built name, ./Child.js. The bundler and the
  // compiler both load Child.ts for it, so the graph must follow it past the entry file, or a
  // change to Child.ts maps to no screen.
  it('follows a .js import to the .ts file the compiler loads for it', async () => {
    const fs = fsOf({
      'src/Page.tsx': `import { Child } from './Child.js';\nimport { Row } from './Row.jsx';\nimport { util } from './util.mjs';`,
      'src/Child.ts': `import { Leaf } from './Leaf.js';`,
      'src/Leaf.tsx': `export const Leaf = 1;`,
      'src/Row.tsx': `export const Row = 1;`,
      'src/util.mts': `export const util = 1;`,
    });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.get('src/Page.tsx')).toEqual(['src/Child.ts', 'src/Row.tsx', 'src/util.mts']);
    expect(graph.get('src/Child.ts')).toEqual(['src/Leaf.tsx']);
    expect(graph.unresolvable).toEqual([]);
  });

  it('keeps a real .js file when it exists, and links both TypeScript names when both exist', async () => {
    const fs = fsOf({
      'src/Page.tsx': `import { A } from './A.js';\nimport { B } from './B.js';`,
      'src/A.js': `export const A = 1;`,
      'src/A.ts': `export const A = 1;`,
      'src/B.ts': `export const B = 1;`,
      'src/B.tsx': `export const B = 1;`,
    });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.get('src/Page.tsx')).toEqual(['src/A.js', 'src/B.ts', 'src/B.tsx']);
    expect(graph.unresolvable).toContainEqual({
      importer: 'src/Page.tsx',
      specifier: './B.js',
      kind: 'ambiguous-candidates',
      candidates: ['src/B.ts', 'src/B.tsx'],
    });
  });

  it('still records a .js import with no file under any name as file-not-found', async () => {
    const fs = fsOf({ 'src/Page.tsx': `import { Gone } from './Gone.js';` });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.unresolvable).toEqual([{ importer: 'src/Page.tsx', specifier: './Gone.js', kind: 'file-not-found' }]);
  });

  it('terminates BFS on cycles', async () => {
    const fs = fsOf({
      'src/A.tsx': `import { B } from './B';`,
      'src/B.tsx': `import { A } from './A';`,
    });
    const graph = await buildImportGraph(fs, ['src/A.tsx']);
    expect(graph.get('src/A.tsx')).toContain('src/B.tsx');
    expect(graph.get('src/B.tsx')).toContain('src/A.tsx');
  });

  it('exposes visited files from BFS', async () => {
    const fs = fsOf({
      'src/A.tsx': `import { B } from './B';`,
      'src/B.tsx': `export const B = 1;`,
    });
    const graph = await buildImportGraph(fs, ['src/A.tsx']);
    expect(graph.visited.has('src/A.tsx')).toBe(true);
    expect(graph.visited.has('src/B.tsx')).toBe(true);
  });

  it('resolves a name with a dot but no module extension by adding one', async () => {
    const fs = fsOf({
      'src/Page.tsx': `import { Widget } from './Widget.spec';\nimport { styles } from './Page.styles';`,
      'src/Widget.spec.tsx': `export const Widget = 1;`,
      'src/Page.styles.ts': `export const styles = 1;`,
    });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.get('src/Page.tsx')).toEqual(['src/Widget.spec.tsx', 'src/Page.styles.ts']);
    expect(graph.unresolvable).toEqual([]);
  });
});

describe('loads the import graph cannot follow', () => {
  const graphOf = (source: string, options = {}) =>
    buildImportGraph(fsOf({ 'src/pages/Page.tsx': source, 'src/tests/Widget.tsx': '' }), ['src/pages/Page.tsx'], undefined, options);

  it('records an import.meta.glob call with its patterns resolved from the importer folder', async () => {
    const graph = await graphOf("const a = import.meta.glob(['../tests/*.tsx', './*.tsx', '!./skip.tsx'], { eager: true });");
    expect(graph.unresolvable).toEqual([
      {
        importer: 'src/pages/Page.tsx',
        specifier: "import.meta.glob(['../tests/*.tsx', './*.tsx', '!./skip.tsx'], { eager: true })",
        kind: 'glob-import',
        patterns: ['src/pages/*.tsx', 'src/tests/*.tsx'],
      },
    ]);
  });

  it('records a glob call it cannot read as one that may load any file', async () => {
    for (const source of [
      'const a = import.meta.glob(PATTERNS);',
      "const a = import.meta.glob('./*.tsx', { base: '../tests' });",
      "const a = import.meta.globEager(`./${dir}/*.tsx`);",
    ]) {
      const graph = await graphOf(source);
      expect(graph.unresolvable.map((entry) => (entry.kind === 'glob-import' ? entry.patterns : 'other')), source).toEqual([null]);
    }
  });

  it('reads a pattern with syntax the matcher does not evaluate as every file in the folder above it', async () => {
    const graph = await graphOf("const a = import.meta.glob('./x?.tsx');");
    expect(graph.unresolvable).toEqual([
      {
        importer: 'src/pages/Page.tsx',
        specifier: "import.meta.glob('./x?.tsx')",
        kind: 'glob-import',
        patterns: ['src/pages/**'],
        widened: ['./x?.tsx'],
      },
    ]);
  });

  it('records a dynamic import or require whose path is built at run time, with its fixed start', async () => {
    const graph = await graphOf(
      'const a = import(`../tests/${name}`);\nconst b = require(name);\nconst c = import(/* webpackChunkName: "x" */ `./${name}.tsx`);',
    );
    expect(graph.unresolvable.map((entry) => (entry.kind === 'dynamic-import' ? entry.prefixes : 'other'))).toEqual([
      ['src/tests/'],
      null,
      ['src/pages/'],
    ]);
  });

  it('leaves out a dynamic import whose fixed start names a package, and follows a fixed path', async () => {
    const graph = await graphOf("const a = import(`@patternfly/react-icons/dist/esm/icons/${name}`);\nconst b = import('../tests/Widget', {});");
    expect(graph.unresolvable).toEqual([]);
    expect(graph.get('src/pages/Page.tsx')).toEqual([]);
    const complete = await graphOf("const b = import('../tests/Widget', {});", { complete: true });
    expect(complete.get('src/pages/Page.tsx')).toEqual(['src/tests/Widget.tsx']);
  });

  it('reads imports across lines, re-exports, side effects, and require in the complete reading', async () => {
    const fs = fsOf({
      'src/Page.tsx': "import {\n  A,\n  B,\n} from './A';\nexport * from './B';\nimport './C';\nconst d = require('./D');\n",
      'src/A.tsx': '',
      'src/B.tsx': '',
      'src/C.tsx': '',
      'src/D.tsx': '',
    });
    expect((await buildImportGraph(fs, ['src/Page.tsx'])).get('src/Page.tsx')).toEqual([]);
    const complete = await buildImportGraph(fs, ['src/Page.tsx'], undefined, { complete: true });
    expect([...complete.get('src/Page.tsx')].sort()).toEqual(['src/A.tsx', 'src/B.tsx', 'src/C.tsx', 'src/D.tsx']);
  });

  it('records a bare import that no package explains in the complete reading only', async () => {
    const fs = fsOf({
      'src/Page.tsx':
        "import React from 'react';\nimport { Icon } from '@patternfly/react-icons/dist/esm/icons/x';\nimport path from 'node:path';\n" +
        "import { join } from 'path';\nimport { W } from 'tests/Widget';\nimport { H } from '#tests/Helper';\nimport { S } from '@acme/shared';",
    });
    expect((await buildImportGraph(fs, ['src/Page.tsx'])).unresolvable).toEqual([]);
    const complete = await buildImportGraph(fs, ['src/Page.tsx'], undefined, {
      complete: true,
      declaredPackages: ['@patternfly/react-icons', 'react'],
    });
    expect(complete.unresolvable).toEqual([
      { importer: 'src/Page.tsx', specifier: 'tests/Widget', kind: 'bare-unknown' },
      { importer: 'src/Page.tsx', specifier: '#tests/Helper', kind: 'bare-unknown' },
      { importer: 'src/Page.tsx', specifier: '@acme/shared', kind: 'bare-unknown' },
    ]);
  });

  it('records a bare import that a baseUrl resolves to a file in the complete reading only', async () => {
    const fs = fsOf({ 'src/Page.tsx': "import { W } from 'tests/Widget';\nimport React from 'react';", 'src/tests/Widget.tsx': '' });
    expect((await buildImportGraph(fs, ['src/Page.tsx'])).unresolvable).toEqual([]);
    const complete = await buildImportGraph(fs, ['src/Page.tsx'], undefined, { complete: true, baseUrlDirs: ['src'] });
    expect(complete.get('src/Page.tsx')).toEqual([]);
    expect(complete.unresolvable).toEqual([
      { importer: 'src/Page.tsx', specifier: 'tests/Widget', kind: 'base-url', candidates: ['src/tests/Widget.tsx'] },
    ]);
  });
});
