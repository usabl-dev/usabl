import { describe, expect, it } from 'vitest';
import type { DocArtifact, Receipt, RequirementBundle, Result, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { collectDocArtifacts, generateDocs, markStaleDocArtifacts, projectDocs } from '../../src/surfaces/docs.js';
import { renderDocsHtml } from '../../src/surfaces/docs-html.js';
import { run } from '../../src/run.js';

// The docs promise: a report is bound to the code it was made from, and a report made from a
// different tree than the current one is marked as needing regeneration. These tests hold that
// on every place a report is listed or read: the artifact list, the JSON envelope, the HTML
// page, and a saved report read back later.

const receipt: Receipt = {
  schemaVersion: 2,
  historyHead: null,
  sourceTree: 'tree-made',
  baseRevision: null,
  policyHash: 'policy-1',
  runnerVersion: '0.0.0-test',
  scannerVersions: { axeCore: '4.13.0', playwright: '1.62.1', chromium: 'revision-123' },
  surfaces: ['clusters'],
  coverage: { checked: ['clusters'], notCovered: [] },
  applicability: [],
  verdict: 'verified',
  findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
  activeWaivers: 0,
  mintedAt: '2026-08-23T00:00:00.000Z',
};

const result = (over: Partial<Result> = {}): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified',
  screens: [
    {
      screenId: 'clusters',
      url: 'http://127.0.0.1:5173/clusters',
      stops: [
        {
          index: 0,
          elementPath: '#save',
          announcement: [{ kind: 'name', text: 'Save', fromTree: true, source: 'ax-tree' }],
        },
      ],
      drafts: [],
      gaps: [],
      applicability: [],
      reachedSelectorPresent: null,
    },
  ],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [],
  receipt,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: 'verified',
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  floorUnconfirmed: [],
  ...over,
});

const noRequirements: RequirementBundle = { version: 1, requirements: [] };

describe('a docs report records the tree it was made from', () => {
  it('records the receipt tree on every artifact of a verified run', () => {
    const artifacts = collectDocArtifacts(result(), noRequirements);

    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(artifact.sourceTree).toBe('tree-made');
    }
  });

  it('records the tree it was given when the run minted no receipt', () => {
    const artifacts = collectDocArtifacts(result({ receipt: null, verdict: 'regression' }), noRequirements, {
      sourceTree: 'tree-read',
    });

    for (const artifact of artifacts) {
      expect(artifact.sourceTree).toBe('tree-read');
    }
  });
});

describe('a report made from another tree is marked stale wherever it is listed or read', () => {
  it('marks every artifact stale in the JSON envelope when the current tree differs', () => {
    const { json, artifacts } = projectDocs(result(), noRequirements, { currentTree: 'tree-now' });

    for (const artifact of artifacts) {
      expect(artifact.stale).toBe(true);
      expect(artifact.staleReason).toContain('tree-made');
      expect(artifact.staleReason).toContain('tree-now');
      expect(artifact.staleReason).toContain('usabl docs');
    }
    expect(JSON.parse(json).artifacts[0].stale).toBe(true);
  });

  it('leaves a report made from the current tree unmarked', () => {
    const { artifacts } = projectDocs(result(), noRequirements, { currentTree: 'tree-made' });

    for (const artifact of artifacts) {
      expect(artifact.stale).toBeUndefined();
      expect(artifact.staleReason).toBeUndefined();
    }
  });

  it('marks a saved report stale when it is read back against a newer tree', () => {
    const saved: DocArtifact[] = JSON.parse(projectDocs(result(), noRequirements).json).artifacts;

    const read = markStaleDocArtifacts(saved, 'tree-later');

    expect(read.every((artifact) => artifact.stale === true)).toBe(true);
    expect(markStaleDocArtifacts(saved, 'tree-made').some((artifact) => artifact.stale === true)).toBe(false);
  });

  it('marks a saved report that names no tree as stale, because nothing binds it to this code', () => {
    const saved: DocArtifact[] = [
      { kind: 'keyboard-paths', surface: 'clusters', entries: [], generatedAt: '' },
    ];

    const [read] = markStaleDocArtifacts(saved, 'tree-later');

    expect(read?.stale).toBe(true);
    expect(read?.staleReason).toContain('does not record');
  });

  it('shows a stale card as out of date on the HTML page and never as verified', () => {
    const { artifacts } = projectDocs(result(), noRequirements, { currentTree: 'tree-now' });

    const html = renderDocsHtml(artifacts);

    expect(html).toContain('Out of date.');
    expect(html).toContain('Run usabl docs again');
    expect(html).not.toContain('<span class="status__label">Verified.</span>');
    expect(html).toMatch(/\d+ out of date/);
  });

  it('says an out-of-date card may not match the current code, which holds for every stale reason', () => {
    // A report that records no tree was not made from another version of the code: usabl cannot
    // tell what it was made from. The footer and the overview say only what is true for every reason.
    const noTree = markStaleDocArtifacts([{ kind: 'keyboard-paths', surface: 'clusters', entries: [], generatedAt: '' }], 'tree-now');

    const html = renderDocsHtml(noTree);

    expect(html).toContain('may not match the current code');
    expect(html).not.toContain('another version of the code');
  });

  it('marks the report stale when the code changed while usabl docs ran', async () => {
    const config: UsablConfig = {
      appBaseUrl: 'http://127.0.0.1:5173',
      uiFileGlobs: ['app/src/**'],
      discovery: { routerFile: 'app/src/App.tsx', wideBlastGlobs: [] },
      surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['app/src/ClustersPage.tsx'] }],
      guardedPaths: ['usabl.config.json'],
    };
    // A failing finding, so the run mints no receipt and the report records the tree read before
    // the run.
    const failing = {
      rule: 'image-alt',
      layer: 'axe',
      severity: 'critical' as const,
      evidenceClass: 'deterministic' as const,
      screenId: 'clusters',
      elementPath: 'img',
      elementName: null,
      role: 'img',
      whatUserExperiences: 'An image has no text alternative.',
      why: 'missing alt',
      fix: 'Add alt text.',
      evidence: {},
      confidence: 'fail' as const,
    };
    const deps = makeFakeDeps({
      changed: [{ code: 'M', path: 'app/src/ClustersPage.tsx' }],
      files: { 'usabl.config.json': '{}', 'app/src/ClustersPage.tsx': 'export const Clusters = () => null;' },
      headContents: { 'usabl.config.json': '{}' },
      writeTree: 'tree-before',
      scans: { clusters: { ...result().screens[0]!, drafts: [failing] } },
    });
    // A file is saved while the scan is in progress: every read of the tree after the scan sees
    // another tree.
    let saved = false;
    const writeTree = deps.git.writeTree.bind(deps.git);
    deps.git.writeTree = async () => (saved ? 'tree-after' : writeTree());
    const scan = deps.checkRunner.scan.bind(deps.checkRunner);
    deps.checkRunner.scan = async (screen) => {
      const scanned = await scan(screen);
      saved = true;
      return scanned;
    };
    const projected = await generateDocs(deps, config, { all: false });

    expect(projected.artifacts.length).toBeGreaterThan(0);
    for (const artifact of projected.artifacts) {
      expect(artifact.sourceTree).toBe('tree-before');
      expect(artifact.stale).toBe(true);
      expect(artifact.staleReason).toContain('tree-after');
    }
  });

  it('marks a verified report stale when the code changed while usabl docs ran', async () => {
    const config: UsablConfig = {
      appBaseUrl: 'http://127.0.0.1:5173',
      uiFileGlobs: ['app/src/**'],
      discovery: { routerFile: 'app/src/App.tsx', wideBlastGlobs: [] },
      surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['app/src/ClustersPage.tsx'] }],
      guardedPaths: ['usabl.config.json'],
    };
    // No finding, so the run mints a receipt. A file is saved after usabl docs reads the tree and
    // before the run reads it. The run sees one tree from plan to scan, so it mints a receipt for
    // the tree with the saved file, and only the tree usabl docs read first shows the change. A
    // file saved during the scan itself mints no receipt; the test above covers that.
    const deps = makeFakeDeps({
      changed: [{ code: 'M', path: 'app/src/ClustersPage.tsx' }],
      files: { 'usabl.config.json': '{}', 'app/src/ClustersPage.tsx': 'export const Clusters = () => null;' },
      headContents: { 'usabl.config.json': '{}' },
      writeTree: 'tree-before',
      scans: { clusters: result().screens[0]! },
    });
    let reads = 0;
    const writeTree = deps.git.writeTree.bind(deps.git);
    deps.git.writeTree = async () => {
      reads += 1;
      return reads === 1 ? writeTree() : 'tree-after';
    };
    const projected = await generateDocs(deps, config, { all: false });

    expect(projected.artifacts.length).toBeGreaterThan(0);
    for (const artifact of projected.artifacts) {
      expect(artifact.boundToReceipt ?? artifact.sourceTree).toBe('tree-after');
      expect(artifact.stale).toBe(true);
      expect(artifact.staleReason).toContain('tree-before');
      expect(artifact.staleReason).toContain('tree-after');
      expect(artifact.staleReason).toContain('usabl docs');
    }
    const html = renderDocsHtml(projected.artifacts);
    expect(html).not.toContain('<span class="status__label">Verified.</span>');
    expect(html).toContain('Out of date.');

    // Read back later against the tree the receipt names, the report is still stale: the scan
    // never saw one whole tree.
    const read = markStaleDocArtifacts(JSON.parse(projected.json).artifacts, 'tree-after');
    expect(read.every((artifact) => artifact.stale === true)).toBe(true);
  });

  it('never shows a clean page as verified when a file was saved during the scan', async () => {
    const config: UsablConfig = {
      appBaseUrl: 'http://127.0.0.1:5173',
      uiFileGlobs: ['app/src/**'],
      discovery: { routerFile: 'app/src/App.tsx', wideBlastGlobs: [] },
      surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['app/src/ClustersPage.tsx'] }],
      guardedPaths: ['usabl.config.json'],
    };
    // No finding, and a file is saved while the scan is in progress: every tree read after the
    // scan sees another tree. The run's two reads differ, so it is not covered and mints no
    // receipt, and the report it makes is out of date.
    const savedDuringScan = () => {
      const deps = makeFakeDeps({
        changed: [{ code: 'M', path: 'app/src/ClustersPage.tsx' }],
        files: { 'usabl.config.json': '{}', 'app/src/ClustersPage.tsx': 'export const Clusters = () => null;' },
        headContents: { 'usabl.config.json': '{}' },
        writeTree: 'tree-before',
        scans: { clusters: result().screens[0]! },
      });
      let saved = false;
      const writeTree = deps.git.writeTree.bind(deps.git);
      deps.git.writeTree = async () => (saved ? 'tree-after' : writeTree());
      const scan = deps.checkRunner.scan.bind(deps.checkRunner);
      deps.checkRunner.scan = async (screen) => {
        const scanned = await scan(screen);
        saved = true;
        return scanned;
      };
      return deps;
    };

    const checked = await run(savedDuringScan(), config);
    expect(checked.verdict).toBe('not_covered');
    expect(checked.receipt).toBeNull();
    expect(checked.coverage.gaps.some((gap) => gap.ref === 'working tree')).toBe(true);

    const projected = await generateDocs(savedDuringScan(), config, { all: false });
    expect(projected.artifacts.length).toBeGreaterThan(0);
    for (const artifact of projected.artifacts) {
      expect(artifact.boundToReceipt).toBeUndefined();
      expect(artifact.sourceTree).toBe('tree-before');
      expect(artifact.stale).toBe(true);
      expect(artifact.staleReason).toContain('tree-after');
    }
    const html = renderDocsHtml(projected.artifacts);
    expect(html).toContain('Out of date.');
    expect(html).not.toContain('<span class="status__label">Verified.</span>');
  });

  it('records the start tree when it differs from the receipt tree, and stays stale against both', () => {
    const artifacts = collectDocArtifacts(result(), noRequirements, { sourceTree: 'tree-start' });

    for (const artifact of artifacts) {
      expect(artifact.sourceTree).toBe('tree-made');
    }
    expect(markStaleDocArtifacts(artifacts, 'tree-made').every((artifact) => artifact.stale === true)).toBe(true);
    expect(markStaleDocArtifacts(artifacts, 'tree-start').every((artifact) => artifact.stale === true)).toBe(true);
    expect(
      markStaleDocArtifacts(collectDocArtifacts(result(), noRequirements, { sourceTree: 'tree-made' }), 'tree-made').some(
        (artifact) => artifact.stale === true,
      ),
    ).toBe(false);
  });
});
