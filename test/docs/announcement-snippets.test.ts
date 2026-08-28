import { describe, expect, it } from 'vitest';
import type { Receipt, Result, ScreenScan } from '../../src/contracts/index.js';
import { generateAnnouncementSnippets } from '../../src/docs/announcement-snippets.js';

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
  surfaces: ['clusters', 'settings'],
  coverage: { checked: ['clusters', 'settings'], notCovered: [] },
  verdict: 'verified',
  findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
  activeWaivers: 0,
  mintedAt: '2026-08-23T00:00:00.000Z',
};

function screenFixture(screenId: string, stops: ScreenScan['stops']): ScreenScan {
  return {
    screenId,
    url: `http://127.0.0.1:5173/${screenId}`,
    stops,
    drafts: [],
    gaps: [],
  };
}

function resultFixture(): Result {
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
            { kind: 'live', text: '', fromTree: true, source: 'attribute' },
          ],
        },
        {
          index: 1,
          elementPath: '#status',
          announcement: [
            { kind: 'live', text: null, fromTree: true, source: 'attribute' },
            { kind: 'state', text: 'busy', fromTree: true, source: 'ax-tree' },
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
  };
}

describe('generateAnnouncementSnippets', () => {
  it('creates one draft artifact per screen with covered stop evidence refs', () => {
    const artifacts = generateAnnouncementSnippets(resultFixture());

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]?.kind).toBe('announcement-snippets');
    expect(artifacts[0]?.surface).toBe('clusters');
    expect(artifacts[0]?.generatedAt).toBe(receiptFixture.mintedAt);
    expect(artifacts[0]?.boundToReceipt).toBe(receiptFixture.sourceTree);
    expect(artifacts[0]?.entries).toHaveLength(2);
    expect(artifacts[0]?.entries[0]?.status).toBe('draft');
    expect(artifacts[0]?.entries[0]?.content).toBe('Save, button');
    expect(artifacts[0]?.entries[0]?.evidenceRef).toMatch(/^stop:tree-123:clusters:0$/);
    expect(artifacts[0]?.entries[1]?.status).toBe('draft');
    expect(artifacts[0]?.entries[1]?.content).toBe('busy');
    expect(artifacts[0]?.entries[1]?.evidenceRef).toMatch(/^stop:tree-123:clusters:1$/);
    expect(artifacts[1]?.surface).toBe('settings');
    expect(artifacts[1]?.entries[0]?.status).toBe('draft');
    expect(artifacts[1]?.entries[0]?.evidenceRef).toMatch(/^stop:tree-123:settings:0$/);
  });

  it('omits receipt binding and stop evidence refs when receipt is null', () => {
    const result = resultFixture();
    result.receipt = null;
    result.verdict = null;
    const artifacts = generateAnnouncementSnippets(result);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]?.generatedAt).toBe('');
    expect(artifacts[0]?.boundToReceipt).toBeUndefined();
    expect(artifacts[0]?.entries[0]).toEqual({
      element: '#save',
      content: 'Save, button',
      status: 'draft',
    });
    expect(artifacts[1]?.entries[0]).toEqual({
      element: '#theme',
      content: 'Theme',
      status: 'draft',
    });
  });

  it('keeps receipt binding but omits refs for uncovered surfaces', () => {
    const result = resultFixture();
    result.receipt = {
      ...receiptFixture,
      coverage: { checked: ['clusters'], notCovered: ['settings'] },
    };

    const artifacts = generateAnnouncementSnippets(result);

    expect(artifacts[1]?.boundToReceipt).toBe('tree-123');
    expect(artifacts[1]?.entries[0]).toEqual({
      element: '#theme',
      content: 'Theme',
      status: 'draft',
    });
  });

  it('neutralizes page-derived stop paths and announcement text', () => {
    const result = resultFixture();
    result.screens = [
      screenFixture('clusters', [
        {
          index: 0,
          elementPath: '#save\u001b[31m',
          announcement: [{ kind: 'name', text: 'Save\u001b[2J', fromTree: true, source: 'ax-tree' }],
        },
      ]),
    ];

    const artifacts = generateAnnouncementSnippets(result);
    expect(artifacts[0]?.entries[0]).toEqual({
      element: '#save',
      content: 'Save',
      status: 'draft',
      evidenceRef: 'stop:tree-123:clusters:0',
    });
  });
});
