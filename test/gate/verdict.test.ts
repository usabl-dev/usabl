import { describe, it, expect } from 'vitest';
import { gate } from '../../src/gate/index.js';
import type { Coverage, Draft, EvidenceFloor } from '../../src/contracts/index.js';

const emptyFloor: EvidenceFloor = { version: 1, entries: [] };
const covered: Coverage = {
  changedFiles: ['fixtures/app/src/ClustersPage.tsx'],
  affected: [{ screenId: 'clusters', url: 'http://x/clusters', provenance: 'manual' }],
  unresolvedFiles: [],
  gaps: [],
  nothingToCheck: false,
};
function d(over: Partial<Draft>): Draft {
  return {
    rule: 'r',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'clusters',
    elementPath: 'button',
    elementName: 'Save',
    role: 'button',
    whatUserExperiences: '',
    why: '',
    fix: '',
    evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
    confidence: 'fail',
    ...over,
  };
}
const base = { guardDivergedPaths: [] as string[], floor: emptyFloor, waivers: [], now: '2026-01-01T00:00:00.000Z' };

describe('gate verdict', () => {
  it('returns approval_required when a guarded path diverged', () => {
    const out = gate({ ...base, coverage: covered, drafts: [], guardDivergedPaths: ['src/gate'] });
    expect(out.verdict).toBe('approval_required');
    expect(out.exitCode).toBe(2);
    expect(out.findings).toEqual([]);
  });

  it('returns null (idle) when nothing to check', () => {
    const coverage: Coverage = { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true };
    const out = gate({ ...base, coverage, drafts: [] });
    expect(out.verdict).toBeNull();
    expect(out.exitCode).toBe(0);
  });

  it('regresses on a new deterministic failure', () => {
    const out = gate({ ...base, coverage: covered, drafts: [d({ rule: 'color-contrast' })] });
    expect(out.verdict).toBe('regression');
    expect(out.exitCode).toBe(1);
  });

  it('ignores preview and model-judgment findings for the verdict', () => {
    const out = gate({
      ...base,
      coverage: covered,
      drafts: [
        d({ rule: 'voicing-x', evidenceClass: 'preview' }),
        d({ rule: 'ai-x', evidenceClass: 'model-judgment' }),
      ],
    });
    expect(out.verdict).toBe('verified');
    expect(out.exitCode).toBe(0);
    expect(out.findings).toHaveLength(2); // surfaced, not gating
  });

  it('returns not_covered when a deterministic finding is unverified', () => {
    const out = gate({ ...base, coverage: covered, drafts: [d({ rule: 'walk-x', confidence: 'unverified' })] });
    expect(out.verdict).toBe('not_covered');
    expect(out.exitCode).toBe(3);
  });

  it('returns not_covered when UI files did not map to a screen', () => {
    const coverage: Coverage = { ...covered, unresolvedFiles: ['fixtures/app/src/Orphan.tsx'] };
    const out = gate({ ...base, coverage, drafts: [] });
    expect(out.verdict).toBe('not_covered');
  });

  it('returns not_covered when coverage reports a scan gap', () => {
    const coverage: Coverage = {
      ...covered,
      gaps: [{ ref: 'http://x/clusters', state: 'not-covered', reason: 'screen failed to open: timeout' }],
    };
    const out = gate({ ...base, coverage, drafts: [] });
    expect(out.verdict).toBe('not_covered');
    expect(out.exitCode).toBe(3);
  });

  it('verifies when there are no gating problems', () => {
    const out = gate({ ...base, coverage: covered, drafts: [] });
    expect(out.verdict).toBe('verified');
    expect(out.exitCode).toBe(0);
  });
});
