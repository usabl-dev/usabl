import { describe, it, expect } from 'vitest';
import { buildImportGraph } from '../../src/coverage/import-graph.js';
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

  it('records an alias import as unresolvable', async () => {
    const fs = fsOf({ 'src/Page.tsx': `import { Foo } from '@/components/Foo';` });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.unresolvable).toContain('src/Page.tsx:@/components/Foo');
  });

  it('records a tilde alias import as unresolvable', async () => {
    const fs = fsOf({ 'src/Page.tsx': `import { Foo } from '~/components/Foo';` });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.unresolvable).toContain('src/Page.tsx:~/components/Foo');
  });

  it('records a relative import with no existing candidate file as unresolvable', async () => {
    const fs = fsOf({ 'src/Page.tsx': `import { Gone } from './Gone';` });
    const graph = await buildImportGraph(fs, ['src/Page.tsx']);
    expect(graph.unresolvable).toContain('src/Page.tsx:./Gone');
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

  it('terminates BFS on cycles', async () => {
    const fs = fsOf({
      'src/A.tsx': `import { B } from './B';`,
      'src/B.tsx': `import { A } from './A';`,
    });
    const graph = await buildImportGraph(fs, ['src/A.tsx']);
    expect(graph.get('src/A.tsx')).toContain('src/B.tsx');
    expect(graph.get('src/B.tsx')).toContain('src/A.tsx');
  });
});
