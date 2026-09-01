import { describe, expect, it } from 'vitest';
import type { CoverageGap, Draft, Result } from '../../src/contracts/index.js';
import { assertUsablVerdict, summarizePageCheck } from '../../src/surfaces/playwright-helper.js';

const draft = (over: Partial<Draft>): Draft => ({
  rule: 'color-contrast',
  layer: 'axe',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'page',
  elementPath: 'button',
  elementName: null,
  role: null,
  whatUserExperiences: 'text is hard to read',
  why: 'contrast below 4.5:1',
  fix: 'raise contrast',
  evidence: {},
  confidence: 'fail',
  ...over,
});

const gap = (over: Partial<CoverageGap> = {}): CoverageGap => ({
  ref: 'provider:pf-rulepack',
  state: 'not-covered',
  reason: 'provider pf-rulepack failed: boom',
  ...over,
});

const baseResult = (over: Partial<Result>): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: 0 gating finding(s)',
  screens: [],
  coverage: {
    changedFiles: [],
    affected: [],
    unresolvedFiles: [],
    gaps: [],
    nothingToCheck: false,
  },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  ...over,
});

describe('assertUsablVerdict', () => {
  it('passes when verdict is in the allowed list', () => {
    const outcome = assertUsablVerdict(baseResult({ verdict: 'verified', exitCode: 0 }), ['verified']);

    expect(outcome.passed).toBe(true);
    expect(outcome.verdict).toBe('verified');
    expect(outcome.exitCode).toBe(0);
  });

  it('fails when verdict is not allowed', () => {
    const outcome = assertUsablVerdict(
      baseResult({ verdict: 'regression', summary: 'regression: 1 new deterministic finding(s)', exitCode: 1 }),
      ['verified'],
    );

    expect(outcome.passed).toBe(false);
    expect(outcome.verdict).toBe('regression');
    expect(outcome.exitCode).toBe(1);
  });

  it('allows not_covered when callers opt into that verdict', () => {
    const outcome = assertUsablVerdict(
      baseResult({ verdict: 'not_covered', summary: 'not_covered: unresolved surfaces', exitCode: 3 }),
      ['verified', 'not_covered'],
    );

    expect(outcome.passed).toBe(true);
    expect(outcome.verdict).toBe('not_covered');
  });

  it('returns a scrubbed safeResult for egress', () => {
    const outcome = assertUsablVerdict(
      baseResult({
        verdict: 'regression',
        exitCode: 1,
        findings: [
          {
            rule: 'color-contrast',
            layer: 'axe',
            severity: 'serious',
            evidenceClass: 'deterministic',
            screenId: 'clusters',
            elementPath: 'button',
            elementName: 'Save',
            role: 'button',
            whatUserExperiences: 'token=SECRETPOISON in page text',
            why: 'token=SECRETPOISON in explanation',
            fix: 'raise contrast',
            evidence: {},
            confidence: 'fail',
            elementKey: 'k',
            identityBasis: 'name',
            status: 'new',
          },
        ],
      }),
      ['verified'],
    );

    expect(JSON.stringify(outcome.safeResult)).not.toContain('SECRETPOISON');
  });
});

describe('summarizePageCheck', () => {
  it('reports verified when there are no drafts and no gaps', () => {
    const result = summarizePageCheck([], []);

    expect(result.verdict).toBe('verified');
    expect(result.failures).toEqual([]);
    expect(result.needsReview).toEqual([]);
    expect(result.gaps).toEqual([]);
    expect(result.drafts).toEqual([]);
  });

  it('reports regression when any draft has fail confidence', () => {
    const failure = draft({ rule: 'image-alt', confidence: 'fail' });

    const result = summarizePageCheck([failure], []);

    expect(result.verdict).toBe('regression');
    expect(result.failures).toEqual([failure]);
    expect(result.needsReview).toEqual([]);
  });

  it('reports not_covered when only unverified drafts are present', () => {
    const incomplete = draft({ rule: 'color-contrast', confidence: 'unverified' });

    const result = summarizePageCheck([incomplete], []);

    expect(result.verdict).toBe('not_covered');
    expect(result.failures).toEqual([]);
    expect(result.needsReview).toEqual([incomplete]);
  });

  it('reports not_covered when a provider gap exists even with clean drafts', () => {
    const result = summarizePageCheck([], [gap()]);

    expect(result.verdict).toBe('not_covered');
    expect(result.gaps).toHaveLength(1);
  });

  it('lets a fail confidence draft outrank unverified drafts and gaps', () => {
    const failure = draft({ rule: 'button-name', confidence: 'fail' });
    const incomplete = draft({ rule: 'color-contrast', confidence: 'unverified' });

    const result = summarizePageCheck([failure, incomplete], [gap()]);

    expect(result.verdict).toBe('regression');
    expect(result.failures).toEqual([failure]);
    expect(result.needsReview).toEqual([incomplete]);
    expect(result.gaps).toHaveLength(1);
  });

  it('summarizes the counts that set the verdict', () => {
    const result = summarizePageCheck(
      [draft({ confidence: 'fail' }), draft({ confidence: 'unverified' })],
      [gap()],
    );

    expect(result.summary).toContain('regression');
    expect(result.summary).toContain('1 blocking');
    expect(result.summary).toContain('1 needs review');
    expect(result.summary).toContain('1 gap');
  });
});
