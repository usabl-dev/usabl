import { describe, it, expect } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { computeIdentity } from '../../src/primitives/identity.js';
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
const base = { guardDivergedPaths: [] as string[], floor: emptyFloor, waivers: [], now: '2026-01-01T00:00:00.000Z', cleanlyScannedScreens: new Set<string>() };

describe('gate verdict', () => {
  it('returns approval_required when a guarded path diverged', () => {
    const out = gate({ ...base, coverage: covered, drafts: [], guardDivergedPaths: ['src/gate'] });
    expect(out.verdict).toBe('approval_required');
    expect(out.exitCode).toBe(2);
    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.accessibilityExitCode).toBe(0);
    expect(out.accessibilityExitCode).not.toBe(2);
  });

  it('keeps accessibility findings on approval_required so mixed PRs can still be judged', () => {
    const out = gate({
      ...base,
      coverage: covered,
      drafts: [d({ rule: 'color-contrast' })],
      guardDivergedPaths: ['.usabl-evidence.json'],
    });
    expect(out.verdict).toBe('approval_required');
    expect(out.exitCode).toBe(2);
    expect(out.accessibilityVerdict).toBe('regression');
    expect(out.accessibilityExitCode).toBe(1);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.rule).toBe('color-contrast');
  });

  it('treats policy-only idle coverage as idle accessibility under approval_required', () => {
    const coverage: Coverage = { changedFiles: ['.usabl-evidence.json'], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true };
    const out = gate({ ...base, coverage, drafts: [], guardDivergedPaths: ['.usabl-evidence.json'] });
    expect(out.verdict).toBe('approval_required');
    expect(out.accessibilityVerdict).toBeNull();
    expect(out.accessibilityExitCode).toBe(0);
    expect(out.findings).toEqual([]);
  });

  it('returns null (idle) when nothing to check', () => {
    const coverage: Coverage = { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true };
    const out = gate({ ...base, coverage, drafts: [] });
    expect(out.verdict).toBeNull();
    expect(out.exitCode).toBe(0);
  });

  it('matches accessibility fields to the verdict when policy did not change', () => {
    const out = gate({ ...base, coverage: covered, drafts: [d({ rule: 'color-contrast' })] });
    expect(out.verdict).toBe('regression');
    expect(out.exitCode).toBe(1);
    expect(out.accessibilityVerdict).toBe('regression');
    expect(out.accessibilityExitCode).toBe(1);
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

  it('returns not_covered when a new deterministic finding is unverified', () => {
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

/**
 * Uncertainty blocks only when it is new.
 *
 * A large application always holds some results the checker declines to judge. When any
 * unverified finding blocked, a floored application stayed at not_covered on every run and no
 * amount of work cleared it, which is the opposite of what the evidence floor promises. These
 * cases pin the rule that replaced it: the floor accepts an identity whatever the confidence,
 * and growth at a floored identity comes back as new through the recorded count.
 */
const unverifiedDraft = (over: Partial<Draft> = {}): Draft =>
  d({ rule: 'walk-x', confidence: 'unverified', ...over });

// The floor identity `unverifiedDraft` collapses to, so a run against this floor carries it.
const flooredWalk = (version: 1 | 2, count: number): EvidenceFloor => {
  const identity = computeIdentity(unverifiedDraft());
  return {
    version,
    entries: [{
      screenId: 'clusters',
      layer: 'axe',
      rule: 'walk-x',
      elementKey: identity.elementKey,
      identityBasis: identity.identityBasis,
      count,
    }],
  };
};

describe('gate verdict on carried uncertainty', () => {
  it('verifies a run whose only unverified finding is carried', () => {
    const out = gate({ ...base, floor: flooredWalk(2, 1), coverage: covered, drafts: [unverifiedDraft()] });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.status).toBe('carried');
    expect(out.verdict).toBe('verified');
    expect(out.exitCode).toBe(0);
  });

  it('still returns not_covered for an unverified finding the floor never accepted', () => {
    const out = gate({
      ...base,
      floor: flooredWalk(2, 1),
      coverage: covered,
      drafts: [unverifiedDraft(), unverifiedDraft({ rule: 'walk-y' })],
    });
    expect(out.findings.find((f) => f.rule === 'walk-y')!.status).toBe('new');
    expect(out.verdict).toBe('not_covered');
    expect(out.exitCode).toBe(3);
  });

  it('returns regression when carried uncertainty sits beside a new failure', () => {
    const out = gate({
      ...base,
      floor: flooredWalk(2, 1),
      coverage: covered,
      drafts: [unverifiedDraft(), d({ rule: 'color-contrast' })],
    });
    expect(out.findings.find((f) => f.rule === 'walk-x')!.status).toBe('carried');
    expect(out.verdict).toBe('regression');
    expect(out.exitCode).toBe(1);
  });

  it('blocks when more findings land on a floored identity than the floor recorded', () => {
    // Two drafts with the same accessible name collapse to the one floored identity. Only the
    // recorded count tells one accepted barrier from two, and it is what makes this run new.
    const out = gate({
      ...base,
      floor: flooredWalk(2, 1),
      coverage: covered,
      drafts: [unverifiedDraft(), unverifiedDraft({ elementPath: 'footer button' })],
    });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.status).toBe('new');
    expect(out.verdict).toBe('not_covered');
    expect(out.exitCode).toBe(3);
  });

  it('still returns not_covered when carried uncertainty meets incomplete coverage', () => {
    const coverage: Coverage = {
      ...covered,
      gaps: [{ ref: 'http://x/clusters', state: 'not-covered', reason: 'screen failed to open: timeout' }],
    };
    const out = gate({ ...base, floor: flooredWalk(2, 1), coverage, drafts: [unverifiedDraft()] });
    expect(out.findings[0]!.status).toBe('carried');
    expect(out.verdict).toBe('not_covered');
    expect(out.exitCode).toBe(3);
  });
});
