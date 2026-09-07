import { describe, it, expect } from 'vitest';
import type {
  AccessibilityVerdict,
  Draft,
  Finding,
  Verdict,
  EvidenceClass,
  ConformanceSummary,
} from '../../src/contracts/index.js';

describe('contracts', () => {
  it('constructs a minimal Draft and Finding', () => {
    const draft: Draft = {
      rule: 'button-name',
      layer: 'axe',
      severity: 'critical',
      evidenceClass: 'deterministic',
      screenId: 'clusters',
      elementPath: 'button:nth-of-type(1)',
      elementName: null,
      role: 'button',
      whatUserExperiences: 'x',
      why: 'y',
      fix: 'z',
      evidence: {},
      confidence: 'fail',
    };
    const finding: Finding = {
      ...draft,
      elementKey: null,
      identityBasis: 'count',
      status: 'new',
    };
    expect(finding.status).toBe('new');
  });

  it('enumerates all four verdicts and the preview evidence class', () => {
    const verdicts: Verdict[] = [
      'verified',
      'regression',
      'not_covered',
      'approval_required',
    ];
    const classes: EvidenceClass[] = [
      'deterministic',
      'preview',
      'model-judgment',
      'human-confirmed',
    ];
    expect(verdicts).toHaveLength(4);
    expect(classes).toContain('preview');
  });

  it('keeps approval_required off the accessibility verdict', () => {
    const accessibility: AccessibilityVerdict[] = ['verified', 'regression', 'not_covered'];
    expect(accessibility).toHaveLength(3);
    // @ts-expect-error approval_required is a Result verdict, not an accessibility verdict
    const forbidden: AccessibilityVerdict = 'approval_required';
    expect(forbidden).toBe('approval_required');
  });

  it('constructs a conformance summary with all buckets shown', () => {
    const summary: ConformanceSummary = {
      verdict: 'verified',
      blocked: false,
      deterministic: { new: 0, newFailing: 0, newUnconfirmed: 0, carried: 1, waived: 0, fixed: 2 },
      judged: { modelJudgment: 3, preview: 1 },
      notEvaluated: { unresolvedFiles: 0, gaps: 0 },
    };
    expect(summary.judged.modelJudgment).toBe(3);
    expect(summary.blocked).toBe(false);
  });
});
