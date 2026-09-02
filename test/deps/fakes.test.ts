import { describe, it, expect } from 'vitest';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import type { ScreenScan } from '../../src/contracts/index.js';

const scan: ScreenScan = { screenId: 'clusters', url: 'http://x/clusters', stops: [], drafts: [], gaps: [], applicability: [] };

describe('makeFakeDeps', () => {
  it('provides a fixed clock and version metadata', () => {
    const deps = makeFakeDeps({ now: '2026-08-19T00:00:00.000Z', runnerVersion: '0.0.0-test' });
    expect(deps.clock()).toBe('2026-08-19T00:00:00.000Z');
    expect(deps.runnerVersion).toBe('0.0.0-test');
  });

  it('returns scripted git status, files, and scans', async () => {
    const deps = makeFakeDeps({
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      files: { 'usabl.config.json': '{}' },
      headBlobs: { 'usabl.config.json': 'sha-config' },
      writeTree: 'tree-abc',
      scans: { clusters: scan },
    });
    expect(await deps.git.statusZ()).toEqual([{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }]);
    expect(await deps.git.writeTree()).toBe('tree-abc');
    expect(await deps.fs.readFile('usabl.config.json')).toBe('{}');
    expect(await deps.git.lsTree('HEAD', ['usabl.config.json'])).toEqual({ 'usabl.config.json': 'sha-config' });
    expect(await deps.checkRunner.scan({ id: 'clusters', url: 'http://x/clusters' })).toEqual(scan);
  });
});
