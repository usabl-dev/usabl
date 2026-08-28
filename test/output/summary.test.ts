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
    expect(
      formatSummary(
        baseResult({ verdict: null, summary: 'nothing to check (no UI-touching files)' }),
      ),
    ).toContain('nothing to check');
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
        summary: 'approval required: 1 guarded path(s) changed',
        exitCode: 2,
        accessibilityVerdict: 'regression',
        accessibilityExitCode: 1,
        dirtyGuardedPaths: ['.usabl-evidence.json'],
      }),
    );
    expect(out).toContain('APPROVAL REQUIRED');
    expect(out).toContain('accessibility REGRESSION');
    expect(out).toContain('.usabl-evidence.json');
  });
});
