/**
 * A run can diverge guarded policy and fail to reach some screens at the same time. The gate
 * already computes the accessibility outcome for that run and carries its findings, verdict and
 * exit code through the approval branch. Only its summary string was thrown away, so the one line
 * every surface interpolates said nothing about coverage.
 *
 * That is not a false green. The block genuinely is the guarded path and the line names it. What
 * the reader loses is that the run was also incomplete, which they then meet for the first time
 * on the run after the approval lands.
 *
 * The rule these tests hold: approval_required is one run with two true facts about it, and the
 * accessibility half reads exactly as it would have read had policy not diverged.
 */
import { describe, it, expect } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import type { Coverage, CoverageGap, Draft, EvidenceFloor, Result } from '../../src/contracts/index.js';

const emptyFloor: EvidenceFloor = { version: 1, entries: [] };
const base = {
  floor: emptyFloor,
  waivers: [],
  now: '2026-01-01T00:00:00.000Z',
  cleanlyScannedScreens: new Set<string>(),
};

const DIVERGED = ['usabl.config.json'];

function d(over: Partial<Draft> = {}): Draft {
  return {
    rule: 'button-name',
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

const gap = (over: Partial<CoverageGap> = {}): CoverageGap => ({
  ref: 'http://x/jobs',
  state: 'not-covered',
  reason: 'screen failed to open: page did not stop changing within 15000ms',
  ...over,
});

function coverage(over: Partial<Coverage> = {}): Coverage {
  return {
    changedFiles: ['src/ClustersPage.tsx'],
    affected: [{ screenId: 'clusters', url: 'http://x/clusters', provenance: 'manual' }],
    unresolvedFiles: [],
    gaps: [],
    nothingToCheck: false,
    ...over,
  };
}

describe('approval_required keeps the accessibility disclosure', () => {
  it('names the missing coverage that the approval line used to drop', () => {
    const out = gate({
      ...base,
      guardDivergedPaths: DIVERGED,
      coverage: coverage({ gaps: [gap(), gap({ ref: 'http://x/nodes' })] }),
      drafts: [],
    });

    expect(out.summary).toContain('2 gap(s)');
  });

  it('reads the accessibility half exactly as it would with no policy divergence', () => {
    // The strongest form of the rule. Whatever this run would have said about accessibility is
    // what it says now, byte for byte, so the operator sees the line they will see again on the
    // run after the approval lands.
    const shared = {
      ...base,
      coverage: coverage({ gaps: [gap()] }),
      drafts: [d()],
    };

    const undiverged = gate({ ...shared, guardDivergedPaths: [] });
    const diverged = gate({ ...shared, guardDivergedPaths: DIVERGED });

    expect(undiverged.summary).toBe('regression: 1 blocking finding(s), 1 gap(s)');
    expect(diverged.summary).toBe(
      `approval required: 1 guarded path(s) changed; accessibility ${undiverged.summary}`,
    );
  });

  it('names the accessibility verdict, so the reader knows what waits after approval', () => {
    const clean = gate({
      ...base,
      guardDivergedPaths: DIVERGED,
      coverage: coverage(),
      drafts: [],
    });

    // Nothing else stands between this run and green once a human approves the policy change.
    expect(clean.summary).toBe(
      'approval required: 1 guarded path(s) changed; accessibility verified: nothing blocking',
    );
  });

  it('says nothing about accessibility when no UI-touching file changed', () => {
    // The common shape of a guarded-path-only edit. There is no coverage to disclose, and
    // "accessibility nothing to check" would be noise on the line that matters least.
    const idle = gate({
      ...base,
      guardDivergedPaths: DIVERGED,
      coverage: coverage({ nothingToCheck: true }),
      drafts: [],
    });

    expect(idle.summary).toBe('approval required: 1 guarded path(s) changed');
    expect(idle.summary).not.toContain('accessibility');
  });

  it('still says nothing about coverage when the run reached everything', () => {
    // The rule from the accessibility summary carries over: a clean run does not print "0 gap(s)",
    // because inventing the clause where it does not apply teaches the reader to skip it.
    const out = gate({
      ...base,
      guardDivergedPaths: DIVERGED,
      coverage: coverage(),
      drafts: [d({ confidence: 'unverified' })],
    });

    expect(out.summary).toContain('accessibility not_covered: 1 blocking finding(s)');
    expect(out.summary).not.toContain('gap(s)');
  });

  it('changes no verdict, exit code or finding', () => {
    // Disclosure only. Every decision on this branch has to come out exactly as before.
    const shared = {
      ...base,
      coverage: coverage({ gaps: [gap()] }),
      drafts: [d()],
    };
    const diverged = gate({ ...shared, guardDivergedPaths: DIVERGED });
    const undiverged = gate({ ...shared, guardDivergedPaths: [] });

    expect(diverged.verdict).toBe('approval_required');
    expect(diverged.exitCode).toBe(2);
    expect(diverged.accessibilityVerdict).toBe('regression');
    expect(diverged.accessibilityExitCode).toBe(1);
    // The accessibility side is untouched by the policy branch.
    expect(diverged.accessibilityVerdict).toBe(undiverged.accessibilityVerdict);
    expect(diverged.accessibilityExitCode).toBe(undiverged.accessibilityExitCode);
    expect(diverged.findings).toEqual(undiverged.findings);
  });
});

describe('the surfaces that only interpolate the summary now disclose it', () => {
  it('reaches the stop hook, which prints no accessibility split of its own', () => {
    // summary.ts and pr-comment.ts already render accessibilityVerdict separately. The stop hook,
    // self check and overlay do not, so for them the summary is the only carrier.
    const gated = gate({
      ...base,
      guardDivergedPaths: DIVERGED,
      coverage: coverage({ gaps: [gap()] }),
      drafts: [],
    });
    const result: Result = {
      schemaVersion: 'usabl.result.v1',
      verdict: gated.verdict,
      summary: gated.summary,
      screens: [],
      coverage: coverage({ gaps: [gap()] }),
      findings: gated.findings,
      receipt: null,
      dirtyGuardedPaths: DIVERGED,
      exitCode: gated.exitCode,
      accessibilityVerdict: gated.accessibilityVerdict,
      accessibilityExitCode: gated.accessibilityExitCode,
      paidDownCount: 0,
    };

    const decision = evaluateStopDecision(result, { stopHookActive: false });

    expect(decision.block).toBe(true);
    expect(decision.message).toContain('1 gap(s)');
  });
});
