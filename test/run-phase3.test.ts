import { describe, expect, it } from 'vitest';
import type { Draft, EvidenceFloor, ScreenScan, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import { run } from '../src/run.js';

const baseConfig: UsablConfig = {
  appBaseUrl: 'http://localhost:3000',
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://localhost:3000/clusters', files: ['src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

const baseFloor: EvidenceFloor = { version: 1, entries: [] };

const unnamedButtonDraft: Draft = {
  rule: 'button-name',
  layer: 'axe',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'clusters',
  elementPath: 'button',
  elementName: null,
  role: 'button',
  whatUserExperiences: 'Screen reader announces button without a name',
  why: 'Button has no accessible name',
  fix: 'Add an accessible name',
  evidence: {},
  confidence: 'fail',
};

const colorContrastClustersDraft: Draft = {
  rule: 'color-contrast',
  layer: 'axe',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'clusters',
  elementPath: 'button',
  elementName: 'Clusters',
  role: 'button',
  whatUserExperiences: 'Text has low contrast',
  why: 'Contrast is below threshold',
  fix: 'Increase contrast ratio',
  evidence: { name: { value: 'Clusters', source: 'ax-tree', fromTree: true } },
  confidence: 'fail',
};

const configBytes = JSON.stringify(baseConfig);
const emptyWaivers = JSON.stringify({ version: 1, waivers: [] });
const emptyRoutes = JSON.stringify({ routes: [] });

function withPolicyFiles(
  files: Record<string, string>,
  headContents: Record<string, string>,
): { files: Record<string, string>; headContents: Record<string, string> } {
  return {
    files: {
      'usabl.config.json': configBytes,
      '.usabl-evidence.json': JSON.stringify(baseFloor),
      '.usabl-waivers.json': emptyWaivers,
      ...files,
    },
    headContents: {
      'usabl.config.json': configBytes,
      '.usabl-evidence.json': JSON.stringify(baseFloor),
      '.usabl-waivers.json': emptyWaivers,
      ...headContents,
    },
  };
}

function screenWith(drafts: Draft[]): ScreenScan {
  return {
    screenId: 'clusters',
    url: 'http://localhost:3000/clusters',
    stops: [],
    drafts,
    gaps: [],
    applicability: [],
  };
}

describe('run phase 3 wiring', () => {
  it('is idle when changedFiles has no UI files and policy is clean', async () => {
    const deps = makeFakeDeps({
      ...withPolicyFiles({}, {}),
      changed: [{ code: 'M', path: 'src/ClustersPage.tsx' }],
    });

    const result = await run(deps, baseConfig, { changedFiles: ['README.md'] });

    expect(result.verdict).toBeNull();
    expect(result.exitCode).toBe(0);
  });

  it('is approval_required when working config diverges from HEAD on docs-only changes', async () => {
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{"tampered":true}',
        '.usabl-evidence.json': JSON.stringify(baseFloor),
        '.usabl-waivers.json': emptyWaivers,
      },
      headContents: {
        'usabl.config.json': configBytes,
        '.usabl-evidence.json': JSON.stringify(baseFloor),
        '.usabl-waivers.json': emptyWaivers,
      },
    });

    const result = await run(deps, baseConfig, { changedFiles: ['README.md'] });

    expect(result.verdict).toBe('approval_required');
    expect(result.dirtyGuardedPaths).toEqual(['usabl.config.json']);
  });

  it('is not_covered with a written gap when a changed UI file maps to nothing', async () => {
    const deps = makeFakeDeps({
      ...withPolicyFiles({ 'usabl.routes.json': emptyRoutes }, { 'usabl.routes.json': emptyRoutes }),
    });

    const result = await run(deps, baseConfig, { changedFiles: ['src/Orphan.tsx'] });

    expect(result.verdict).toBe('not_covered');
    expect(result.coverage.unresolvedFiles).toEqual(['src/Orphan.tsx']);
    expect(result.coverage.gaps[0]?.reason).not.toBe('');
  });

  it('converges to verified for count-based floor entries on button-name', async () => {
    const floor: EvidenceFloor = {
      version: 1,
      entries: [
        {
          screenId: 'clusters',
          layer: 'axe',
          rule: 'button-name',
          elementKey: null,
          identityBasis: 'count',
          count: 1,
        },
      ],
    };
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': JSON.stringify(floor) }, { '.usabl-evidence.json': JSON.stringify(floor) }),
      writeTree: 'tree-count-floor',
      scans: { clusters: screenWith([unnamedButtonDraft]) },
    });

    const result = await run(deps, baseConfig, { changedFiles: ['src/ClustersPage.tsx'] });

    expect(result.verdict).toBe('verified');
    expect(result.receipt?.sourceTree).toBe('tree-count-floor');
    expect(result.findings.find((f) => f.rule === 'button-name')?.status).toBe('carried');
  });

  it('discloses a coverage gap instead of verifying against a version 1 floor', async () => {
    const floor = {
      version: 1,
      entries: [
        {
          screenId: 'clusters',
          layer: 'axe',
          rule: 'color-contrast',
          elementKey: 'clusters|color-contrast|name:clusters',
          identityBasis: 'name',
          count: 1,
        },
      ],
    };
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': JSON.stringify(floor) }, { '.usabl-evidence.json': JSON.stringify(floor) }),
      scans: { clusters: screenWith([colorContrastClustersDraft]) },
    });

    const result = await run(deps, baseConfig, { changedFiles: ['src/ClustersPage.tsx'] });

    const gap = result.coverage.gaps.find((g) => g.ref === '.usabl-evidence.json');
    expect(gap).toBeDefined();
    expect(gap?.state).toBe('not-covered');
    expect(gap?.reason).toContain('predates count tracking');
    expect(gap?.reason).toContain('usabl baseline');
    expect(result.verdict).toBe('not_covered');
    expect(result.receipt).toBeNull();
  });

  it('does not disclose a version 1 gap when the floor holds only count-basis entries', async () => {
    const floor: EvidenceFloor = {
      version: 1,
      entries: [
        {
          screenId: 'clusters',
          layer: 'axe',
          rule: 'button-name',
          elementKey: null,
          identityBasis: 'count',
          count: 1,
        },
      ],
    };
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': JSON.stringify(floor) }, { '.usabl-evidence.json': JSON.stringify(floor) }),
      scans: { clusters: screenWith([unnamedButtonDraft]) },
    });

    const result = await run(deps, baseConfig, { changedFiles: ['src/ClustersPage.tsx'] });

    expect(result.coverage.gaps.find((g) => g.ref === '.usabl-evidence.json')).toBeUndefined();
    expect(result.verdict).toBe('verified');
  });

  it('converges to verified for name-keyed floor entries on color-contrast', async () => {
    const floor: EvidenceFloor = {
      version: 2,
      entries: [
        {
          screenId: 'clusters',
          layer: 'axe',
          rule: 'color-contrast',
          elementKey: 'clusters|color-contrast|name:clusters',
          identityBasis: 'name',
          count: 1,
        },
      ],
    };
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': JSON.stringify(floor) }, { '.usabl-evidence.json': JSON.stringify(floor) }),
      writeTree: 'tree-name-floor',
      scans: { clusters: screenWith([colorContrastClustersDraft]) },
    });

    const result = await run(deps, baseConfig, { changedFiles: ['src/ClustersPage.tsx'] });

    expect(result.verdict).toBe('verified');
    expect(result.findings.find((f) => f.rule === 'color-contrast')?.status).toBe('carried');
  });

  it('never self-accepts a working-tree floor when trustedRef is used for floor reads', async () => {
    const acceptedWorkingFloor: EvidenceFloor = {
      version: 1,
      entries: [
        {
          screenId: 'clusters',
          layer: 'axe',
          rule: 'button-name',
          elementKey: null,
          identityBasis: 'count',
          count: 1,
        },
      ],
    };
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': configBytes,
        '.usabl-evidence.json': JSON.stringify(acceptedWorkingFloor),
        '.usabl-waivers.json': emptyWaivers,
      },
      headContents: {
        'usabl.config.json': configBytes,
        '.usabl-evidence.json': JSON.stringify(baseFloor),
        '.usabl-waivers.json': emptyWaivers,
      },
      scans: { clusters: screenWith([unnamedButtonDraft]) },
    });

    const result = await run(deps, baseConfig, {
      changedFiles: ['src/ClustersPage.tsx'],
      trustedRef: 'HEAD',
    });

    expect(result.verdict).not.toBe('verified');
    expect(result.receipt).toBeNull();
  });

  it('is not_covered when wide-blast matches and sidecar has no routes', async () => {
    const config: UsablConfig = {
      ...baseConfig,
      discovery: { ...baseConfig.discovery, wideBlastGlobs: ['src/**/*.tsx'] },
    };
    const deps = makeFakeDeps({
      ...withPolicyFiles({ 'usabl.routes.json': emptyRoutes }, { 'usabl.routes.json': emptyRoutes }),
    });

    const result = await run(deps, config, { changedFiles: ['src/Shell.tsx'] });

    expect(result.verdict).toBe('not_covered');
    expect(result.verdict).not.toBe('verified');
    expect(result.coverage.gaps[0]?.reason).not.toBe('');
  });
});
