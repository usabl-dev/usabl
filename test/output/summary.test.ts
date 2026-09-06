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
    expect(out).toContain('RUN FAILED');
    expect(out).not.toContain('IDLE');
    expect(out).toContain('never saw the application');
    expect(out).toContain('next: run usabl check again');
  });

  describe('verdict line', () => {
    const states: Array<{ name: string; result: Result; word: string; exit: number }> = [
      { name: 'verified', result: baseResult({}), word: 'VERIFIED', exit: 0 },
      {
        name: 'regression',
        result: baseResult({ verdict: 'regression', exitCode: 1, summary: 'regression: 1 gating finding(s)' }),
        word: 'REGRESSION',
        exit: 1,
      },
      {
        name: 'not_covered',
        result: baseResult({ verdict: 'not_covered', exitCode: 3, summary: 'not_covered: 0 gating finding(s), 1 gap(s)' }),
        word: 'NOT COVERED',
        exit: 3,
      },
      {
        name: 'approval_required',
        result: baseResult({
          verdict: 'approval_required',
          exitCode: 2,
          summary: 'approval required: 1 guarded path(s) changed',
          dirtyGuardedPaths: ['usabl.config.json'],
        }),
        word: 'APPROVAL REQUIRED',
        exit: 2,
      },
      {
        name: 'idle',
        result: baseResult({ verdict: null, exitCode: 0, summary: 'nothing to check (no UI-touching files)' }),
        word: 'NO VERDICT: IDLE',
        exit: 0,
      },
      {
        name: 'crash',
        result: baseResult({ verdict: null, exitCode: 4, summary: 'unhandled error: read ECONNRESET' }),
        word: 'NO VERDICT: RUN FAILED',
        exit: 4,
      },
    ];

    for (const state of states) {
      it(`opens ${state.name} with a symbol, the word, the exit code, then one sentence`, () => {
        const lines = formatSummary(state.result).split('\n');
        const first = lines[0]!;
        const second = lines[1]!;

        // usabl, a symbol, the word, and the exit code, in that order, on the first line.
        expect(first).toMatch(new RegExp(`^usabl: \\S+ ${state.word.replace(/[:]/g, '\\$&')} \\(exit ${state.exit}\\)$`));
        // The sentence on the second line, indented, ending in a period, inside 80 columns.
        expect(second).toMatch(/^  [A-Za-z].*\.$/);
        expect(second.length).toBeLessThanOrEqual(80);
        // The gate's own summary is still printed, labelled, on its own line.
        expect(lines).toContain(`  gate summary: ${state.result.summary}`);
      });
    }

    it('keeps the two no-verdict states apart and never lets either read as a pass', () => {
      const idle = formatSummary(states[4]!.result);
      const crash = formatSummary(states[5]!.result);

      expect(idle.toLowerCase()).not.toContain('verified');
      expect(crash.toLowerCase()).not.toContain('verified');
      expect(idle).toContain('NO VERDICT');
      expect(crash).toContain('NO VERDICT');
      expect(idle.split('\n')[0]).not.toBe(crash.split('\n')[0]);
      expect(idle).not.toContain('RUN FAILED');
      expect(crash).not.toContain('IDLE');
    });

    it('carries every meaning in text: no state relies on colour', () => {
      for (const state of states) {
        const out = formatSummary(state.result);
        expect(out).not.toContain('\u001b');
        expect(out).toContain(state.word);
        expect(out).toContain(`exit ${state.exit}`);
      }
    });

    it('keeps every line usabl authors itself inside 80 columns', () => {
      for (const state of states) {
        const authored = formatSummary(state.result)
          .split('\n')
          .filter((line) => !line.includes('gate summary:'));
        for (const line of authored) {
          expect(line.length).toBeLessThanOrEqual(80);
        }
      }
    });
  });

  it('labels the barrier list and keeps source and fix under each barrier', () => {
    const out = formatSummary(
      baseResult({
        verdict: 'regression',
        exitCode: 1,
        summary: 'regression: 1 gating finding(s)',
        findings: [
          {
            rule: 'button-name',
            layer: 'axe',
            severity: 'serious',
            evidenceClass: 'deterministic',
            screenId: 'clusters',
            elementPath: 'button',
            elementName: 'Save',
            role: 'button',
            whatUserExperiences: 'A button with no accessible name',
            why: '',
            fix: 'Add aria-label',
            evidence: {},
            confidence: 'fail',
            elementKey: 'k',
            identityBasis: 'name',
            status: 'new',
          },
        ],
      }),
    );
    const lines = out.split('\n');
    const barriers = lines.indexOf('  barriers:');
    expect(barriers).toBeGreaterThan(1);
    expect(lines[barriers + 1]).toBe('    [new] clusters · axe/button-name (serious): A button with no accessible name');
    expect(lines[barriers + 2]).toBe('        fix: Add aria-label');
  });

  it('prints no barrier header when there is no gating finding', () => {
    expect(formatSummary(baseResult({}))).not.toContain('barriers:');
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

  it('keeps Unicode line separators off the terminal without welding the words together', () => {
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
    // The separator becomes a space, so the forged verdict cannot claim a line of its own and the
    // words on either side are still two words rather than one.
    expect(out).toContain('Low contrast usabl: VERIFIED');
    expect(out).toContain('Raise contrast usabl: VERIFIED');
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
