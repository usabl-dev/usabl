import { describe, expect, it, vi } from 'vitest';
import type { Draft, ScreenScan, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { generateDocs, wholeAppFiles } from '../../src/surfaces/docs.js';

// The same two screens the docs projection tests use: clusters and settings.
const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['app/src/**'],
  discovery: { routerFile: 'app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [
    { id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['app/src/ClustersPage.tsx'] },
    { id: 'settings', url: 'http://127.0.0.1:5173/settings', files: ['app/src/SettingsPage.tsx'] },
  ],
  guardedPaths: ['usabl.config.json'],
};

function scanOf(screenId: string, images: ScreenScan['images'], drafts: Draft[] = []): ScreenScan {
  return {
    screenId,
    url: `http://127.0.0.1:5173/${screenId}`,
    stops: [
      {
        index: 0,
        elementPath: `#${screenId}-save`,
        announcement: [{ kind: 'name', text: 'Save', fromTree: true, source: 'ax-tree' }],
      },
    ],
    drafts,
    gaps: [],
    applicability: [],
    reachedSelectorPresent: null,
    ...(images === undefined ? {} : { images }),
  };
}

function cleanTreeDeps(drafts: Draft[] = []) {
  return makeFakeDeps({
    // A clean working tree: git reports no change at all.
    changed: [],
    files: {
      'usabl.config.json': '{}',
      'app/src/ClustersPage.tsx': 'export const Clusters = () => null;',
      'app/src/SettingsPage.tsx': 'export const Settings = () => null;',
      'app/src/ClustersPage.test.tsx': 'test file',
    },
    headContents: { 'usabl.config.json': '{}' },
    scans: {
      clusters: scanOf('clusters', [{ elementPath: '#logo', name: 'Company logo', role: 'img', decorative: false }], drafts),
      settings: scanOf('settings', [{ elementPath: '#avatar', name: '', role: null, decorative: true }]),
    },
  });
}

const failing: Draft = {
  rule: 'image-alt',
  layer: 'axe',
  severity: 'critical',
  evidenceClass: 'deterministic',
  screenId: 'clusters',
  elementPath: '#logo',
  elementName: null,
  role: 'img',
  whatUserExperiences: 'An image has no text alternative.',
  why: 'axe found no alt text.',
  fix: 'Add alt text.',
  evidence: {},
  confidence: 'fail',
};

describe('usabl docs --all', () => {
  it('documents every screen on a clean tree and drafts a non-empty alt-text manifest from the page', async () => {
    const deps = cleanTreeDeps();
    const scan = vi.spyOn(deps.checkRunner, 'scan');

    const { artifacts } = await generateDocs(deps, config, { all: true });

    expect(scan.mock.calls.map(([screen]) => screen.id).sort()).toEqual(['clusters', 'settings']);
    for (const kind of ['announcement-snippets', 'keyboard-paths', 'alt-text-manifest']) {
      expect(artifacts.filter((artifact) => artifact.kind === kind).map((artifact) => artifact.surface).sort()).toEqual([
        'clusters',
        'settings',
      ]);
    }
    const manifests = artifacts.filter((artifact) => artifact.kind === 'alt-text-manifest');
    expect(manifests.every((manifest) => manifest.entries.length > 0)).toBe(true);
    expect(manifests.flatMap((manifest) => manifest.entries).every((entry) => entry.origin === 'page')).toBe(true);
  });

  it('documents nothing on a clean tree without --all, as before', async () => {
    const deps = cleanTreeDeps();
    const scan = vi.spyOn(deps.checkRunner, 'scan');

    const { artifacts } = await generateDocs(deps, config, { all: false });

    expect(scan).not.toHaveBeenCalled();
    expect(artifacts).toEqual([]);
  });

  it('takes honesty only from the receipt: a run with a new accessibility barrier binds nothing', async () => {
    const { artifacts } = await generateDocs(cleanTreeDeps([failing]), config, { all: true });

    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(artifact.boundToReceipt).toBeUndefined();
      expect(artifact.entries.every((entry) => entry.evidenceRef === undefined)).toBe(true);
    }
  });

  it('never gives a page-drafted entry evidence, even when the whole-app run is verified', async () => {
    const { artifacts } = await generateDocs(cleanTreeDeps(), config, { all: true });

    // The run was verified, so the manifest is bound to its receipt: the bound-without-evidence state.
    const manifests = artifacts.filter((artifact) => artifact.kind === 'alt-text-manifest');
    expect(manifests.every((manifest) => manifest.boundToReceipt === 'tree-0000')).toBe(true);
    const pageEntries = artifacts.flatMap((artifact) => artifact.entries).filter((entry) => entry.origin === 'page');
    expect(pageEntries.length).toBeGreaterThan(0);
    expect(pageEntries.every((entry) => entry.evidenceRef === undefined && entry.status === 'draft')).toBe(true);
  });
});

describe('wholeAppFiles', () => {
  it('lists every UI file and every surface file, sorted and without duplicates', async () => {
    const deps = cleanTreeDeps();

    expect(await wholeAppFiles(deps.fs, config)).toEqual([
      'app/src/ClustersPage.test.tsx',
      'app/src/ClustersPage.tsx',
      'app/src/SettingsPage.tsx',
    ]);
  });

  it('adds the sources of every docs page in usabl.docs.json', async () => {
    const manifest = JSON.stringify({
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: 'npm run build:docs',
      pages: [
        {
          pageId: 'getting-started',
          url: '/getting-started.html',
          assemblyFile: 'modules/getting-started.adoc',
          sources: ['modules/getting-started.adoc', 'modules/shared.adoc'],
        },
      ],
      sharedGlobs: [],
    });
    const deps = makeFakeDeps({ files: { 'usabl.docs.json': manifest } });

    expect(await wholeAppFiles(deps.fs, { ...config, uiFileGlobs: [], surfaces: [] })).toEqual([
      'modules/getting-started.adoc',
      'modules/shared.adoc',
    ]);
  });
});
