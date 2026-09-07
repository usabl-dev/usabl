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
  floorHeadroom: [],
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
    const barriers = lines.indexOf('  barriers that block this run: 1 finding(s)');
    expect(barriers).toBeGreaterThan(1);
    expect(lines[barriers + 1]).toBe('    [new] clusters · axe/button-name (serious): A button with no accessible name');
    expect(lines[barriers + 2]).toBe('        fix: Add aria-label');
  });

  it('prints no barrier header when there is no gating finding', () => {
    expect(formatSummary(baseResult({}))).not.toContain('barriers');
  });

  /**
   * The evidence floor is the promise this surface used to break.
   *
   * Existing debt is recorded, it does not gate, and only a new barrier blocks. The terminal
   * filtered findings to new-or-carried, printed them all under a heading that read "barriers:",
   * and gave every one of them a "fix:" line. So a verified run carrying floor debt printed the
   * word VERIFIED and then a list of barriers to fix, which is the opposite of what the gate had
   * just decided. A waived finding was invisible here, which is its own kind of wrong.
   *
   * The rule these tests hold: what blocks is listed as work, under a heading that says it blocks;
   * what the gate already accepted is listed as recorded, under a heading that says it does not
   * block; and the work is never below the debt.
   */
  describe('barriers and recorded debt are listed apart', () => {
    const BLOCKING_HEADING = '  barriers that block this run:';
    const RECORDED_HEADING = '  recorded, not blocking:';
    const RECORDED_NOTE = '    usabl already recorded these. They do not block this run.';

    const withStatus = (
      over: Partial<Result['findings'][number]>,
    ): Result['findings'][number] => ({
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
      status: 'carried',
      ...over,
    });

    const verifiedWithCarried = baseResult({
      verdict: 'verified',
      exitCode: 0,
      summary: 'verified: 0 gating finding(s)',
      findings: [withStatus({ status: 'carried' })],
    });

    const verifiedWithWaived = baseResult({
      verdict: 'verified',
      exitCode: 0,
      summary: 'verified: 0 gating finding(s)',
      findings: [withStatus({ status: 'waived', rule: 'link-name', fix: 'Name the link' })],
    });

    const regressionWithBoth = baseResult({
      verdict: 'regression',
      exitCode: 1,
      summary: 'regression: 1 gating finding(s)',
      findings: [
        withStatus({ status: 'carried', rule: 'color-contrast' }),
        withStatus({
          status: 'new',
          rule: 'button-name',
          whatUserExperiences: 'A button with no accessible name',
          fix: 'Add aria-label',
        }),
      ],
    });

    const notCoveredWithCarried = baseResult({
      verdict: 'not_covered',
      exitCode: 3,
      summary: 'not_covered: 0 gating finding(s), 1 gap(s)',
      findings: [withStatus({ status: 'carried' })],
      coverage: {
        changedFiles: [],
        affected: [],
        unresolvedFiles: [],
        gaps: [{ ref: 'http://127.0.0.1:5173/jobs', state: 'not-covered', reason: 'never opened' }],
        nothingToCheck: false,
      },
    });

    it('lists carried debt on a verified run as recorded, never as a barrier', () => {
      const out = formatSummary(verifiedWithCarried);
      const lines = out.split('\n');

      expect(out).toContain('VERIFIED');
      expect(lines).toContain(`${RECORDED_HEADING} 1 finding(s)`);
      expect(lines).toContain(RECORDED_NOTE);
      expect(out).not.toContain(BLOCKING_HEADING);
      // The finding itself is still listed, with everything a reader needs to act on it.
      expect(lines).toContain('    [carried] clusters · axe/color-contrast (serious): Low contrast text');
    });

    it('lists a waived finding on a verified run as recorded, and keeps its fix', () => {
      const out = formatSummary(verifiedWithWaived);
      const lines = out.split('\n');

      expect(lines).toContain(`${RECORDED_HEADING} 1 finding(s)`);
      expect(out).not.toContain(BLOCKING_HEADING);
      // The fix survives, because a developer may choose to pay the debt down. It is not phrased
      // as an instruction to do it now.
      expect(lines).toContain('        fix when you choose to: Name the link');
    });

    it('never tells a reader to fix anything under a verified verdict', () => {
      for (const result of [verifiedWithCarried, verifiedWithWaived]) {
        const out = formatSummary(result);
        expect(out).toContain('VERIFIED');
        // "fix:" is the label this surface puts on work. Under a verified verdict there is none,
        // so the only fix wording left is the one that says the choice is the reader's.
        expect(out).not.toMatch(/^ *fix: /m);
        expect(out).not.toContain('barriers');
      }
    });

    it('puts new barriers above carried debt on a regression, and marks the debt as not blocking', () => {
      const lines = formatSummary(regressionWithBoth).split('\n');
      const blocking = lines.indexOf(`${BLOCKING_HEADING} 1 finding(s)`);
      const recorded = lines.indexOf(`${RECORDED_HEADING} 1 finding(s)`);

      expect(blocking).toBeGreaterThan(1);
      // The work comes first. A reader with something to fix never scrolls past debt to find it.
      expect(recorded).toBeGreaterThan(blocking);
      expect(lines[blocking + 1]).toBe(
        '    [new] clusters · axe/button-name (serious): A button with no accessible name',
      );
      expect(lines[blocking + 2]).toBe('        fix: Add aria-label');
      expect(lines[recorded + 1]).toBe(RECORDED_NOTE);
      expect(lines[recorded + 2]).toBe(
        '    [carried] clusters · axe/color-contrast (serious): Low contrast text',
      );
      expect(lines[recorded + 3]).toBe('        fix when you choose to: Raise contrast to 4.5:1');
    });

    it('keeps carried debt out of the barrier list on a not-covered run', () => {
      const out = formatSummary(notCoveredWithCarried);
      const lines = out.split('\n');

      expect(out).toContain('NOT COVERED');
      // The run is unproven because of a gap, not because of the debt it carries.
      expect(out).not.toContain(BLOCKING_HEADING);
      expect(lines).toContain(`${RECORDED_HEADING} 1 finding(s)`);
      expect(out).toContain('not evaluated: 1 gap(s)');
    });

    it('lists carried uncertainty as recorded debt, not as a barrier', () => {
      // The floor accepted this identity, so the gate lets the run pass and the reader is not
      // sent to fix it. The shared predicate is what decides that, and this pins the surface to it.
      const out = formatSummary(
        baseResult({
          verdict: 'verified',
          exitCode: 0,
          summary: 'verified: 1 gating finding(s)',
          findings: [withStatus({ status: 'carried', confidence: 'unverified' })],
        }),
      );

      expect(out).toContain(`${RECORDED_HEADING} 1 finding(s)`);
      expect(out).not.toContain(BLOCKING_HEADING);
    });

    it('calls a new finding usabl could not verify a barrier', () => {
      // The gate cannot call a run verified while a new finding is unverified, so this one is work.
      const out = formatSummary(
        baseResult({
          verdict: 'not_covered',
          exitCode: 3,
          summary: 'not_covered: 1 gating finding(s)',
          findings: [withStatus({ status: 'new', confidence: 'unverified' })],
        }),
      );

      expect(out).toContain(`${BLOCKING_HEADING} 1 finding(s)`);
      expect(out).not.toContain(RECORDED_HEADING);
    });

    it('lists the floor entries to re-arm under the recorded group, without a barrier heading', () => {
      // Headroom is maintenance, not work. It appears under a verified run, so it must never be
      // rendered as something blocking and must never be filed under the barrier heading.
      const out = formatSummary(
        baseResult({
          verdict: 'verified',
          exitCode: 0,
          summary: 'verified: nothing blocking, 1 recorded, 1 floor entry to re-arm',
          findings: [withStatus({ status: 'carried' })],
          floorHeadroom: [{ screenId: 'clusters', rule: 'pf-icon-button-name', recorded: 15, observed: 12 }],
        }),
      );
      const lines = out.split('\n');

      expect(out).toContain('VERIFIED');
      expect(out).not.toContain(BLOCKING_HEADING);
      expect(lines).toContain('  floor ahead of this run: 1 entry');
      expect(lines).toContain('    Barriers were fixed here. Run usabl floor prune to re-arm the floor.');
      // Both numbers, so the reader can see how far ahead the floor is without opening the file.
      expect(lines).toContain('    clusters - pf-icon-button-name: floor records 15, this run saw 12');
    });

    it('says nothing about re-arming when there is no headroom', () => {
      const out = formatSummary(verifiedWithCarried);

      expect(out).not.toContain('floor ahead of this run');
      expect(out).not.toContain('floor prune');
    });

    it('keeps every heading and note it authors inside 80 columns', () => {
      for (const result of [verifiedWithCarried, regressionWithBoth, notCoveredWithCarried]) {
        const authored = formatSummary(result)
          .split('\n')
          .filter((line) => line.startsWith('  barriers') || line.startsWith('  recorded') || line === RECORDED_NOTE);
        expect(authored.length).toBeGreaterThan(0);
        for (const line of authored) {
          expect(line.length).toBeLessThanOrEqual(80);
        }
      }
    });
  });

  describe('length bound on each field', () => {
    const huge = (seed: string) => `${seed} ${'x'.repeat(50_000)}`;
    const oversized = baseResult({
      verdict: 'regression',
      exitCode: 1,
      summary: 'regression: 1 gating finding(s), 1 gap(s)',
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
          whatUserExperiences: huge('EXPERIENCE'),
          why: '',
          fix: huge('FIX'),
          evidence: {},
          confidence: 'fail',
          elementKey: 'k',
          identityBasis: 'name',
          status: 'new',
        },
      ],
      coverage: {
        changedFiles: [],
        affected: [],
        unresolvedFiles: [],
        gaps: [{ ref: 'http://127.0.0.1:5173/jobs', state: 'not-covered', reason: huge('REASON') }],
        nothingToCheck: false,
      },
    });

    it('shortens an oversized experience, fix, and gap reason with a visible note', () => {
      const out = formatSummary(oversized);

      const notes = out.match(/\[shortened, \d+ characters omitted\]/g) ?? [];
      expect(notes.length).toBe(3);
      expect(out).toContain('(serious): EXPERIENCE');
      expect(out).toContain('fix: FIX');
      expect(out).toContain('[not-covered] http://127.0.0.1:5173/jobs: REASON');
      // The gap count and the verdict line are never cut.
      expect(out).toContain('not evaluated: 1 gap(s)');
      expect(out.split('\n')[0]).toBe('usabl: ✖ REGRESSION (exit 1)');
      expect(out.length).toBeLessThan(3_000);
    });

    it('shortens an oversized crash summary but keeps the verdict line whole', () => {
      const out = formatSummary(baseResult({ verdict: null, exitCode: 4, summary: huge('unhandled error: boom') }));

      expect(out.split('\n')[0]).toBe('usabl: ! NO VERDICT: RUN FAILED (exit 4)');
      expect(out).toContain('gate summary: unhandled error: boom');
      expect(out).toContain('characters omitted]');
      expect(out.length).toBeLessThan(1_000);
    });

    it('leaves a normal report untouched: no note appears', () => {
      const out = formatSummary(
        baseResult({ verdict: 'regression', exitCode: 1, findings: oversized.findings.map((f) => ({ ...f, whatUserExperiences: 'Low contrast', fix: 'Raise contrast' })) }),
      );

      expect(out).not.toContain('shortened');
      expect(out).toContain('(serious): Low contrast');
      expect(out).toContain('fix: Raise contrast');
    });
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
        floorHeadroom: [],
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
        floorHeadroom: [],
      }),
    );
    expect(out).not.toContain('floor');
  });
});
