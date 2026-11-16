import { describe, it, expect } from 'vitest';
import { makeFakeDeps, makeFakePage, treeEntryOf } from '../../src/deps/fakes.js';
import type { ScreenScan, StoredEntry } from '../../src/contracts/index.js';

const scan: ScreenScan = { screenId: 'clusters', url: 'http://x/clusters', stops: [], drafts: [], gaps: [], applicability: [], reachedSelectorPresent: null };

describe('makeFakeDeps', () => {
  it('reads bytes and tree entries through the text reads, so a test that replaces show or readFile changes both', async () => {
    const deps = makeFakeDeps({ files: { 'a.json': 'working' }, headContents: { 'a.json': 'head' } });
    const bytesOf = (entry: StoredEntry | null | undefined): string | null =>
      entry?.kind === 'file' ? new TextDecoder().decode(entry.bytes) : null;
    const idOf = async (git: typeof deps.git, path: string, recursive: boolean): Promise<string | undefined> =>
      (await git.listEntries('HEAD', [path], { recursive })).get(path)?.id;
    expect(await idOf(deps.git, 'a.json', false)).toBe(treeEntryOf('head').id);
    expect(await idOf(deps.git, 'a.json', true)).toBe(treeEntryOf('head').id);
    expect(bytesOf(await deps.fs.readBytes?.('a.json'))).toBe('working');
    await expect(idOf(deps.git, 'missing.json', false)).resolves.toBeUndefined();
    deps.git.show = async () => 'replaced head';
    deps.fs.readFile = async () => 'replaced working';
    expect(await idOf(deps.git, 'a.json', false)).toBe(treeEntryOf('replaced head').id);
    expect(bytesOf(await deps.fs.readBytes?.('a.json'))).toBe('replaced working');
    const spread = { ...deps.git, show: async () => 'spread head' };
    expect(await idOf(spread, 'a.json', false)).toBe(treeEntryOf('spread head').id);
  });

  it('gives the tree entry git gives the same text', () => {
    // git hash-object of "head" (no line break).
    expect(treeEntryOf('head')).toEqual({ mode: '100644', type: 'blob', id: '7266ebb383fab07522cdf02586290cace6e3474c' });
  });

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

describe('makeFakePage', () => {
  it('drains a record from the page\'s own drain, with nothing undecidable', async () => {
    const page = makeFakePage({ drainAnnouncements: async () => ['Saved'] });
    expect(await page.drainAnnouncementRecord()).toEqual({ texts: ['Saved'], undecidable: null });
  });
});
