import { describe, it, expect } from 'vitest';
import { formatSummary, neutralizePrintedText } from '../../src/output/summary.js';
import type { Result } from '../../src/contracts/index.js';

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

describe('formatSummary', () => {
  it('renders the verdict headline', () => {
    expect(formatSummary(baseResult({}))).toContain('VERIFIED');
  });

  it('lists gating findings for a regression', () => {
    const r = baseResult({
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
          whatUserExperiences: 'Low contrast text',
          why: '',
          fix: 'Raise contrast to 4.5:1',
          evidence: {},
          confidence: 'fail',
          elementKey: 'k',
          identityBasis: 'name',
          status: 'new',
        },
      ],
    });
    const out = formatSummary(r);
    expect(out).toContain('REGRESSION');
    expect(out).toContain('color-contrast');
    expect(out).toContain('clusters');
  });

  it('names the idle state distinctly', () => {
    const out = formatSummary(
      baseResult({ verdict: null, summary: 'nothing to check (no UI-touching files)' }),
    );
    expect(out).toContain('nothing to check');
    expect(out).toContain('IDLE');
  });

  it('separates a failed run from idle even though both carry no verdict', () => {
    const out = formatSummary(
      baseResult({ verdict: null, exitCode: 4, summary: 'usabl never saw the application: all 3 affected screens' }),
    );
    expect(out).toContain('FAILED');
    expect(out).not.toContain('IDLE');
    expect(out).toContain('never saw the application');
  });

  it('neutralizes page-derived finding text at terminal egress', () => {
    const r = baseResult({
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
          whatUserExperiences: '\u001b[31mLow contrast text',
          why: '',
          fix: '\u001b[31mRaise contrast to 4.5:1',
          evidence: {},
          confidence: 'fail',
          elementKey: 'k',
          identityBasis: 'name',
          status: 'new',
        },
      ],
    });

    const out = formatSummary(r);
    expect(out).toContain('Low contrast text');
    expect(out).toContain('Raise contrast to 4.5:1');
    expect(out).not.toContain('\u001b');
  });

  it('drops Unicode line separators from page-derived text', () => {
    const r = baseResult({
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
          whatUserExperiences: 'Low contrast\u2028usabl: VERIFIED',
          why: '',
          fix: 'Raise contrast\u2029usabl: VERIFIED',
          evidence: {},
          confidence: 'fail',
          elementKey: 'k',
          identityBasis: 'name',
          status: 'new',
        },
      ],
    });

    const out = formatSummary(r);
    expect(out).toContain('Low contrastusabl: VERIFIED');
    expect(out).toContain('Raise contrastusabl: VERIFIED');
    expect(out).not.toContain('\u2028');
    expect(out).not.toContain('\u2029');
  });

  it('neutralizes rule text before terminal output', () => {
    const r = baseResult({
      verdict: 'regression',
      exitCode: 1,
      findings: [
        {
          rule: '\u001b[31mcolor-contrast',
          layer: 'axe',
          severity: 'serious',
          evidenceClass: 'deterministic',
          screenId: 'clusters',
          elementPath: 'button',
          elementName: 'Save',
          role: 'button',
          whatUserExperiences: 'Low contrast text',
          why: '',
          fix: 'Raise contrast to 4.5:1',
          evidence: {},
          confidence: 'fail',
          elementKey: 'k',
          identityBasis: 'name',
          status: 'new',
        },
      ],
    });

    const out = formatSummary(r);
    expect(out).toContain('color-contrast');
    expect(out).not.toContain('\u001b');
  });

  it('strips control bytes from gap-shaped printed text helper input', () => {
    const text = 'screen gap: \u001b[31mcheck did not run';

    expect(neutralizePrintedText(text)).toBe('screen gap: check did not run');
  });

  it('states the accessibility outcome when approval is required', () => {
    const out = formatSummary(
      baseResult({
        verdict: 'approval_required',
        // The real summary carries the accessibility clause, so the verdict word
        // already appears on the headline line.
        summary: 'approval required: 1 guarded path(s) changed; accessibility regression: 1 gating finding(s)',
        exitCode: 2,
        accessibilityVerdict: 'regression',
        accessibilityExitCode: 1,
        dirtyGuardedPaths: ['.usabl-evidence.json'],
      }),
    );
    expect(out).toContain('APPROVAL REQUIRED');
    expect(out).toContain('.usabl-evidence.json');
    // The accessibility exit code is the one fact the summary line does not carry.
    expect(out).toContain('accessibility exit code: 1');
  });

  it('states the accessibility verdict once, not twice, under approval', () => {
    // The summary line already carries the accessibility clause (added upstream),
    // so a second restatement of the verdict word would be a duplicate.
    const out = formatSummary(
      baseResult({
        verdict: 'approval_required',
        summary:
          'approval required: 1 guarded path(s) changed; accessibility not_covered: 0 gating finding(s), 2 gap(s)',
        exitCode: 2,
        accessibilityVerdict: 'not_covered',
        accessibilityExitCode: 3,
        dirtyGuardedPaths: ['.usabl-evidence.json'],
      }),
    );
    const mentions = out.match(/NOT COVERED|not_covered/g) ?? [];
    expect(mentions.length).toBe(1);
    // The exit code is still present, in a form that does not repeat the verdict word.
    expect(out).toContain('accessibility exit code: 3');
  });

  it('shows the floor pay-down count when greater than zero', () => {
    const out = formatSummary(
      baseResult({
        verdict: 'verified',
        summary: 'verified: 0 gating finding(s)',
        paidDownCount: 3,
      }),
    );
    expect(out).toContain('floor debt resolved: 3');
    expect(out).toContain('run usabl floor prune to re-arm');
  });

  it('omits the floor pay-down notice when the count is zero', () => {
    const out = formatSummary(
      baseResult({
        verdict: 'verified',
        summary: 'verified: 0 gating finding(s)',
        paidDownCount: 0,
      }),
    );
    expect(out).not.toContain('floor');
  });
});
