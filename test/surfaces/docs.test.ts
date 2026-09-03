import { describe, expect, it } from 'vitest';
import type { Receipt, RequirementBundle, Result, ScreenScan } from '../../src/contracts/index.js';
import { collectDocArtifacts, projectDocs } from '../../src/surfaces/docs.js';

const receiptFixture: Receipt = {
  schemaVersion: 1,
  sourceTree: 'tree-123',
  baseRevision: null,
  policyHash: 'policy-1',
  runnerVersion: '0.0.0-test',
  scannerVersions: { axeCore: '4.13.0', playwright: '1.62.1', chromium: 'revision-123' },
  surfaces: ['clusters', 'settings'],
  coverage: { checked: ['clusters', 'settings'], notCovered: [] },
  verdict: 'verified',
  findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
  activeWaivers: 0,
  mintedAt: '2026-08-23T00:00:00.000Z',
};

function screenFixture(screenId: string, stops: ScreenScan['stops']): ScreenScan {
  return { screenId, url: `http://127.0.0.1:5173/${screenId}`, stops, drafts: [], gaps: [], applicability: [], reachedSelectorPresent: null };
}

function resultFixture(overrides: Partial<Result> = {}): Result {
  return {
    schemaVersion: 'usabl.result.v1',
    verdict: 'verified',
    summary: 'test result',
    screens: [
      screenFixture('clusters', [
        {
          index: 0,
          elementPath: '#save',
          announcement: [
            { kind: 'name', text: 'Save', fromTree: true, source: 'ax-tree' },
            { kind: 'role', text: 'button', fromTree: true, source: 'ax-tree' },
          ],
        },
      ]),
      screenFixture('settings', [
        {
          index: 0,
          elementPath: '#theme',
          announcement: [{ kind: 'name', text: 'Theme', fromTree: true, source: 'ax-tree' }],
        },
      ]),
    ],
    coverage: {
      changedFiles: [],
      affected: [],
      unresolvedFiles: [],
      gaps: [],
      nothingToCheck: false,
    },
    findings: [],
    receipt: receiptFixture,
    dirtyGuardedPaths: [],
    exitCode: 0,
    accessibilityVerdict: 'verified',
    accessibilityExitCode: 0,
  paidDownCount: 0,
    ...overrides,
  };
}

const bundleFixture: RequirementBundle = {
  version: 1,
  requirements: [
    {
      id: 'alt-logo',
      kind: 'content',
      surface: 'clusters',
      description: 'Logo alt text',
      assertion: { type: 'content', selector: 'img.logo', expectedText: 'Company logo' },
      approved: true,
    },
  ],
};

describe('collectDocArtifacts', () => {
  it('emits announcement snippets and keyboard paths per screen plus alt-text per content surface', () => {
    const artifacts = collectDocArtifacts(resultFixture(), bundleFixture);

    const byKind = (kind: string) => artifacts.filter((artifact) => artifact.kind === kind);
    expect(byKind('announcement-snippets')).toHaveLength(2);
    expect(byKind('keyboard-paths')).toHaveLength(2);
    expect(byKind('alt-text-manifest')).toHaveLength(1);

    const altText = byKind('alt-text-manifest')[0];
    expect(altText?.surface).toBe('clusters');
    expect(altText?.entries[0]).toEqual({
      element: 'img.logo',
      content: 'Company logo',
      status: 'approved',
    });
  });

  it('emits no alt-text manifest when no content requirements are configured', () => {
    const artifacts = collectDocArtifacts(resultFixture(), { version: 1, requirements: [] });

    expect(artifacts.filter((artifact) => artifact.kind === 'alt-text-manifest')).toHaveLength(0);
    // The two transcript-derived kinds still generate from the run's screens.
    expect(artifacts.filter((artifact) => artifact.kind === 'announcement-snippets')).toHaveLength(2);
    expect(artifacts.filter((artifact) => artifact.kind === 'keyboard-paths')).toHaveLength(2);
  });

  it('emits one alt-text manifest per distinct content surface, sorted', () => {
    const bundle: RequirementBundle = {
      version: 1,
      requirements: [
        {
          id: 'a',
          kind: 'content',
          surface: 'settings',
          description: 's',
          assertion: { type: 'content', selector: '#s', expectedText: 'S' },
          approved: false,
        },
        {
          id: 'b',
          kind: 'content',
          surface: 'clusters',
          description: 'c',
          assertion: { type: 'content', selector: '#c', expectedText: 'C' },
          approved: true,
        },
      ],
    };

    const manifests = collectDocArtifacts(resultFixture(), bundle).filter(
      (artifact) => artifact.kind === 'alt-text-manifest',
    );

    expect(manifests.map((manifest) => manifest.surface)).toEqual(['clusters', 'settings']);
  });

  it('scrubs page-derived transcript text before egress', () => {
    const result = resultFixture({
      screens: [
        screenFixture('clusters', [
          {
            index: 0,
            elementPath: '#save[31m',
            announcement: [{ kind: 'name', text: 'Save[2J', fromTree: true, source: 'ax-tree' }],
          },
        ]),
      ],
    });

    const artifacts = collectDocArtifacts(result, { version: 1, requirements: [] });
    const snippet = artifacts.find((artifact) => artifact.kind === 'announcement-snippets');
    expect(snippet?.entries[0]?.element).toBe('#save');
    expect(snippet?.entries[0]?.content).toBe('Save');
    expect(JSON.stringify(artifacts)).not.toContain('');
  });
});

describe('projectDocs', () => {
  it('serializes artifacts as parseable JSON under an artifacts key', () => {
    const projected = projectDocs(resultFixture(), bundleFixture);

    const parsed: unknown = JSON.parse(projected.json);
    expect(parsed).toEqual({ artifacts: projected.artifacts });
    expect(Array.isArray(projected.artifacts)).toBe(true);
    expect(projected.artifacts.length).toBeGreaterThan(0);
  });
});
