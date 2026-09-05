import { describe, expect, it } from 'vitest';
import type { Receipt, Result } from '../../src/contracts/index.js';
import { buildEvidenceBinding, surfaceWasChecked } from '../../src/docs/evidence-binding.js';

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
  coverage: { checked: ['clusters'], notCovered: ['settings'] },
  applicability: [],
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
    screens: [],
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

describe('evidence-binding helpers', () => {
  it('marks a surface as checked only when result receipt coverage includes it', () => {
    expect(surfaceWasChecked(makeResult(receiptFixture), 'clusters')).toBe(true);
    expect(surfaceWasChecked(makeResult(receiptFixture), 'settings')).toBe(false);
    expect(surfaceWasChecked(makeResult(null), 'clusters')).toBe(false);
  });

  it('binds to receipt tree and minted clock when receipt exists', () => {
    expect(buildEvidenceBinding(makeResult(receiptFixture), 'clusters')).toEqual({
      receipt: receiptFixture,
      covered: true,
      generatedAt: '2026-08-23T00:00:00.000Z',
      boundToReceipt: 'tree-123',
    });
  });

  it('uses empty generatedAt and no bound receipt when result receipt is null', () => {
    expect(buildEvidenceBinding(makeResult(null), 'clusters')).toEqual({
      receipt: null,
      covered: false,
      generatedAt: '',
    });
  });
});
