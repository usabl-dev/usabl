import { describe, it, expect } from 'vitest';
import type {
  Draft,
  Finding,
  Result,
  Verdict,
  EvidenceClass,
  Waiver,
  EvidenceFloor,
  UsablConfig,
  GateInput,
  GateOutput,
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

  it('constructs a conformance summary with all buckets shown', () => {
    const summary: ConformanceSummary = {
      verdict: 'verified',
      blocked: false,
      deterministic: { newFailures: 0, carried: 1, waived: 0, fixed: 2 },
      judged: { modelJudgment: 3, preview: 1 },
      notEvaluated: { unresolvedFiles: 0, gaps: 0 },
    };
    expect(summary.judged.modelJudgment).toBe(3);
    expect(summary.blocked).toBe(false);
  });
});
