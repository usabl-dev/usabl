import { describe, expect, it } from 'vitest';
import type { Receipt, RequirementBundle, Result } from '../../src/contracts/index.js';
import { generateAltTextManifest } from '../../src/docs/alt-text-manifest.js';

const receiptFixture: Receipt = {
  schemaVersion: 1,
  sourceTree: 'tree-123',
  baseRevision: null,
  policyHash: 'policy-1',
  runnerVersion: '0.0.0-test',
  scannerVersions: {
    axeCore: '4.13.0',
    playwright: '1.62.1',
    chromium: 'revision-123',
  },
  surfaces: ['clusters'],
  coverage: { checked: ['clusters'], notCovered: [] },
  verdict: 'verified',
  findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
  activeWaivers: 0,
  mintedAt: '2026-08-23T00:00:00.000Z',
};

function makeResult(receipt: Receipt | null): Result {
  return {
    schemaVersion: 'usabl.result.v1',
    verdict: receipt === null ? null : 'verified',
    summary: 'test result',
    screens: [
      {
        screenId: 'clusters',
        url: 'http://127.0.0.1:5173/clusters',
        stops: [],
        drafts: [],
        gaps: [],
        applicability: [],
        reachedSelectorPresent: null,
      },
    ],
    coverage: {
      changedFiles: [],
      affected: [],
      unresolvedFiles: [],
      gaps: [],
      nothingToCheck: false,
    },
    findings: [],
    receipt,
    dirtyGuardedPaths: [],
    exitCode: 0,
    accessibilityVerdict: receipt === null ? null : 'verified',
    accessibilityExitCode: 0,
    paidDownCount: 0,
  };
}

function bundleFixture(): RequirementBundle {
  return {
    version: 1,
    requirements: [
      {
        id: 'hero-alt',
        kind: 'content',
        surface: 'clusters',
        description: 'Hero image alt text',
        assertion: {
          type: 'content',
          selector: 'img.hero',
          expectedText: 'Hero image',
        },
        approved: true,
      },
      {
        id: 'draft-alt',
        kind: 'content',
        surface: 'clusters',
        description: 'Logo alt text draft',
        assertion: {
          type: 'content',
          selector: 'img.logo',
          expectedText: 'Company logo',
        },
        approved: false,
      },
      {
        id: 'skip-other-surface',
        kind: 'content',
        surface: 'settings',
        description: 'Settings icon text',
        assertion: {
          type: 'content',
          selector: 'img.settings',
          expectedText: 'Settings icon',
        },
        approved: true,
      },
      {
        id: 'skip-no-expected-text',
        kind: 'content',
        surface: 'clusters',
        description: 'No expected text should not render',
        assertion: {
          type: 'content',
          selector: 'img.empty',
        },
        approved: true,
      },
    ],
  };
}

describe('generateAltTextManifest', () => {
  it('binds approved covered requirements without selector-level evidence refs', () => {
    const artifact = generateAltTextManifest(makeResult(receiptFixture), bundleFixture(), 'clusters');

    expect(artifact.kind).toBe('alt-text-manifest');
    expect(artifact.surface).toBe('clusters');
    expect(artifact.generatedAt).toBe(receiptFixture.mintedAt);
    expect(artifact.boundToReceipt).toBe(receiptFixture.sourceTree);
    expect(artifact.entries).toContainEqual({
      element: 'img.hero',
      content: 'Hero image',
      status: 'approved',
    });
  });

  it('marks unapproved requirements as draft', () => {
    const artifact = generateAltTextManifest(makeResult(receiptFixture), bundleFixture(), 'clusters');

    expect(artifact.entries).toContainEqual({
      element: 'img.logo',
      content: 'Company logo',
      status: 'draft',
    });
  });

  it('omits receipt binding and evidence refs when receipt is null', () => {
    const artifact = generateAltTextManifest(makeResult(null), bundleFixture(), 'clusters');

    expect(artifact.generatedAt).toBe('');
    expect(artifact.boundToReceipt).toBeUndefined();
    expect(artifact.entries).toEqual([
      { element: 'img.hero', content: 'Hero image', status: 'approved' },
      { element: 'img.logo', content: 'Company logo', status: 'draft' },
    ]);
  });

  it('keeps receipt binding but omits evidence refs when surface is not covered', () => {
    const uncoveredReceipt: Receipt = {
      ...receiptFixture,
      coverage: { checked: [], notCovered: ['clusters'] },
    };

    const artifact = generateAltTextManifest(makeResult(uncoveredReceipt), bundleFixture(), 'clusters');

    expect(artifact.generatedAt).toBe(uncoveredReceipt.mintedAt);
    expect(artifact.boundToReceipt).toBe(uncoveredReceipt.sourceTree);
    expect(artifact.entries).toEqual([
      { element: 'img.hero', content: 'Hero image', status: 'approved' },
      { element: 'img.logo', content: 'Company logo', status: 'draft' },
    ]);
  });

  it('skips requirements from other surfaces', () => {
    const artifact = generateAltTextManifest(makeResult(receiptFixture), bundleFixture(), 'clusters');

    expect(artifact.entries).toHaveLength(2);
    expect(artifact.entries.map((entry) => entry.element)).toEqual(['img.hero', 'img.logo']);
  });
});
