import { describe, expect, it } from 'vitest';
import type { Receipt, RequirementBundle, Result, ScreenScan } from '../../src/contracts/index.js';
import { collectDocArtifacts, projectDocs } from '../../src/surfaces/docs.js';

const receiptFixture: Receipt = {
  schemaVersion: 2,
  historyHead: null,
  sourceTree: 'tree-123',
  baseRevision: null,
  policyHash: 'policy-1',
  runnerVersion: '0.0.0-test',
  scannerVersions: { axeCore: '4.13.0', playwright: '1.62.1', chromium: 'revision-123' },
  surfaces: ['clusters', 'settings'],
  coverage: { checked: ['clusters', 'settings'], notCovered: [] },
  applicability: [],
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
  floorHeadroom: [],
  floorUnconfirmed: [],
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

describe('collectDocArtifacts alt-text manifest drafted from the page', () => {
  const noRequirements: RequirementBundle = { version: 1, requirements: [] };

  function withImages(): Result {
    return resultFixture({
      screens: [
        {
          ...screenFixture('clusters', []),
          images: [
            { elementPath: '#logo', name: 'Company logo', role: 'img', decorative: false },
            { elementPath: '#divider', name: '', role: null, decorative: true },
            { elementPath: '#chart', name: null, role: null, decorative: false },
          ],
        },
        { ...screenFixture('settings', []), images: [{ elementPath: '#avatar', name: 'Your photo', role: 'img', decorative: false }] },
      ],
    });
  }

  it('drafts one manifest per screen from the page when there are no content requirements', () => {
    const manifests = collectDocArtifacts(withImages(), noRequirements).filter(
      (artifact) => artifact.kind === 'alt-text-manifest',
    );

    expect(manifests.map((manifest) => manifest.surface)).toEqual(['clusters', 'settings']);
    expect(manifests[0]?.entries).toEqual([
      { element: '#logo', content: 'Company logo', status: 'draft', origin: 'page' },
      { element: '#divider', content: 'Marked decorative on the page.', status: 'draft', origin: 'page' },
      { element: '#chart', content: 'No text alternative on the page.', status: 'draft', origin: 'page' },
    ]);
  });

  it('never marks a page-drafted entry approved or gives it evidence, even on a verified run', () => {
    const manifests = collectDocArtifacts(withImages(), noRequirements).filter(
      (artifact) => artifact.kind === 'alt-text-manifest',
    );

    // Bound to the receipt as a whole, so the card reads as bound without evidence, never verified.
    expect(manifests.every((manifest) => manifest.boundToReceipt === 'tree-123')).toBe(true);
    for (const entry of manifests.flatMap((manifest) => manifest.entries)) {
      expect(entry.status).toBe('draft');
      expect(entry.origin).toBe('page');
      expect(entry.evidenceRef).toBeUndefined();
    }
  });

  it('binds nothing when the run minted no receipt', () => {
    const manifests = collectDocArtifacts({ ...withImages(), receipt: null, verdict: 'regression' }, noRequirements).filter(
      (artifact) => artifact.kind === 'alt-text-manifest',
    );

    expect(manifests).toHaveLength(2);
    expect(manifests.every((manifest) => manifest.boundToReceipt === undefined)).toBe(true);
  });

  it('keeps the content requirements for a surface that has them and drafts only the others', () => {
    const manifests = collectDocArtifacts(withImages(), bundleFixture).filter(
      (artifact) => artifact.kind === 'alt-text-manifest',
    );

    expect(manifests.map((manifest) => [manifest.surface, manifest.entries[0]?.origin ?? 'intake'])).toEqual([
      ['clusters', 'intake'],
      ['settings', 'page'],
    ]);
  });

  it('drafts nothing for a screen whose images were not read', () => {
    const artifacts = collectDocArtifacts(resultFixture(), noRequirements);

    expect(artifacts.filter((artifact) => artifact.kind === 'alt-text-manifest')).toHaveLength(0);
  });

  it('says how many images were not listed', () => {
    const result = resultFixture({
      screens: [{ ...screenFixture('clusters', []), images: [], imagesNotListed: 7 }],
    });

    const manifest = collectDocArtifacts(result, noRequirements).find((artifact) => artifact.kind === 'alt-text-manifest');

    expect(manifest?.entries).toEqual([
      {
        element: '(not listed)',
        content: '7 more images on this screen were not listed. usabl lists at most 200 images per screen.',
        status: 'draft',
        origin: 'page',
      },
    ]);
  });

  it('scrubs and shortens page text before it reaches a manifest', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const result = resultFixture({
      screens: [
        {
          ...screenFixture('clusters', []),
          images: [
            { elementPath: '#x\u001b[31m', name: `Logo \u001b[2J${token}`, role: 'img', decorative: false },
            { elementPath: '#long', name: 'word '.repeat(200), role: 'img', decorative: false },
          ],
        },
      ],
    });

    const manifest = collectDocArtifacts(result, noRequirements).find((artifact) => artifact.kind === 'alt-text-manifest');
    const [first, second] = manifest?.entries ?? [];

    expect(first?.element).toBe('#x');
    expect(first?.content).not.toContain(token);
    expect(first?.content).not.toContain('\u001b');
    expect(second?.content.length).toBeLessThanOrEqual(200);
    expect(second?.content.endsWith('(shortened)')).toBe(true);
  });

  it('does not add page text to the requirement bundle', () => {
    const bundle: RequirementBundle = { version: 1, requirements: [] };

    collectDocArtifacts(withImages(), bundle);

    expect(bundle).toEqual({ version: 1, requirements: [] });
  });

  it('is deterministic for the same input', () => {
    expect(collectDocArtifacts(withImages(), noRequirements)).toEqual(collectDocArtifacts(withImages(), noRequirements));
  });
});
