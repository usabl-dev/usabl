import { describe, it, expect } from 'vitest';
import { formatSummary } from '../../src/output/summary.js';
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
});
