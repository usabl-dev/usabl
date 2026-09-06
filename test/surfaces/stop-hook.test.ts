import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';

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

describe('evaluateStopDecision', () => {
  it('allows verified results', () => {
    const decision = evaluateStopDecision(
      baseResult({
        verdict: 'verified',
        receipt: {
          schemaVersion: 1,
          sourceTree: 'tree-verified',
          baseRevision: null,
          policyHash: 'hash',
          runnerVersion: '0.0.0-test',
          scannerVersions: { axeCore: '4.13.0', playwright: '1.62.1', chromium: 'revision-123' },
          surfaces: ['cli'],
          coverage: { checked: ['clusters'], notCovered: [] },
          applicability: [],
          verdict: 'verified',
          findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
          activeWaivers: 0,
          mintedAt: '2026-08-23T00:00:00.000Z',
        },
      }),
      { stopHookActive: false },
    );

    expect(decision.block).toBe(false);
    expect(decision.message).toContain('tree-verified');
  });

  it('allows when there is nothing to check', () => {
    const decision = evaluateStopDecision(
      baseResult({
        verdict: null,
        summary: 'nothing to check (no UI-touching files)',
        coverage: {
          changedFiles: [],
          affected: [],
          unresolvedFiles: [],
          gaps: [],
          nothingToCheck: true,
        },
      }),
      { stopHookActive: false },
    );

    expect(decision.block).toBe(false);
    expect(decision.message).toContain('nothing to check');
  });

  it('blocks regression, approval_required, and not_covered', () => {
    const verdicts: Array<'regression' | 'approval_required' | 'not_covered'> = [
      'regression',
      'approval_required',
      'not_covered',
    ];
    for (const verdict of verdicts) {
      const decision = evaluateStopDecision(baseResult({ verdict, summary: `${verdict} summary` }), {
        stopHookActive: false,
      });
      expect(decision.block).toBe(true);
      expect(decision.message.length).toBeGreaterThan(0);
    }
  });

  it('does not block while stop hook continuation is active', () => {
    const decision = evaluateStopDecision(baseResult({ verdict: 'regression' }), { stopHookActive: true });

    expect(decision.block).toBe(false);
    expect(decision.message).toContain('NOT verified');
  });

  it('allows exitCode 4 with explicit disclosure', () => {
    const decision = evaluateStopDecision(
      baseResult({
        verdict: null,
        exitCode: 4,
        summary: 'unhandled error: read ECONNRESET',
      }),
      { stopHookActive: false },
    );

    expect(decision.block).toBe(false);
    expect(decision.message).toContain('NO VERDICT: RUN FAILED (exit 4)');
    expect(decision.message).toContain('read ECONNRESET');
    expect(decision.message).toContain('Next: run usabl check again');
  });

  describe('verdict line', () => {
    const idle = baseResult({
      verdict: null,
      exitCode: 0,
      summary: 'nothing to check (no UI-touching files)',
      coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true },
    });
    const crash = baseResult({ verdict: null, exitCode: 4, summary: 'unhandled error: read ECONNRESET' });
    const blocking: Array<{ result: Result; word: string }> = [
      {
        result: baseResult({ verdict: 'regression', exitCode: 1, summary: 'regression: 1 gating finding(s)' }),
        word: 'REGRESSION (exit 1)',
      },
      {
        result: baseResult({ verdict: 'not_covered', exitCode: 3, summary: 'not_covered: 0 gating finding(s), 1 gap(s)' }),
        word: 'NOT COVERED (exit 3)',
      },
      {
        result: baseResult({
          verdict: 'approval_required',
          exitCode: 2,
          summary: 'approval required: 1 guarded path(s) changed',
        }),
        word: 'APPROVAL REQUIRED (exit 2)',
      },
    ];

    for (const { result, word } of blocking) {
      it(`opens a ${word} block with the word, the exit code, the meaning, the summary, then the next step`, () => {
        const lines = evaluateStopDecision(result, { stopHookActive: false }).message.split('\n');

        expect(lines[0]!.startsWith(`${word}: NOT verified. `)).toBe(true);
        expect(lines[0]!.endsWith('.')).toBe(true);
        expect(lines[1]).toBe(`Gate summary: ${result.summary}`);
        expect(lines[2]!.startsWith('Next: ')).toBe(true);
      });
    }

    it('opens a verified allow with the word and the exit code', () => {
      const message = evaluateStopDecision(baseResult({}), { stopHookActive: false }).message;

      expect(message.startsWith('VERIFIED (exit 0): ')).toBe(true);
      expect(message).toContain('You may stop.');
    });

    it('opens a continuation allow with the word, the exit code, and the reason it did not block', () => {
      const lines = evaluateStopDecision(blocking[0]!.result, { stopHookActive: true }).message.split('\n');

      expect(lines[0]!.startsWith('REGRESSION (exit 1): NOT verified. ')).toBe(true);
      expect(lines[0]).toContain('continuation already active');
      expect(lines[1]).toBe('Gate summary: regression: 1 gating finding(s)');
      expect(lines[2]!.startsWith('Next: ')).toBe(true);
    });

    it('tells idle and a failed run apart, and lets neither name the word verified', () => {
      const idleMessage = evaluateStopDecision(idle, { stopHookActive: false }).message;
      const crashMessage = evaluateStopDecision(crash, { stopHookActive: false }).message;

      expect(idleMessage.startsWith('NO VERDICT: IDLE (exit 0): ')).toBe(true);
      expect(crashMessage.startsWith('NO VERDICT: RUN FAILED (exit 4): ')).toBe(true);
      expect(idleMessage.toLowerCase()).not.toContain('verified');
      expect(crashMessage.toLowerCase()).not.toContain('verified');
      expect(idleMessage).not.toContain('FAILED');
      expect(crashMessage).not.toContain('IDLE');
      // Idle may stop. A failed run must not be read as permission to claim anything.
      expect(idleMessage).toContain('You may stop.');
      expect(crashMessage).not.toContain('You may stop.');
    });

    it('carries every meaning in text: no message relies on colour', () => {
      const all = [idle, crash, baseResult({}), ...blocking.map((entry) => entry.result)];
      for (const result of all) {
        expect(evaluateStopDecision(result, { stopHookActive: false }).message).not.toContain('\u001b');
      }
    });
  });

  describe('length bound on each field', () => {
    const finding = (over: Partial<Result['findings'][number]>): Result['findings'][number] => ({
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
      ...over,
    });
    const huge = (seed: string) => `${seed} ${'x'.repeat(50_000)}`;

    it('shortens an oversized experience, fix, and gap reason with a visible note', () => {
      const decision = evaluateStopDecision(
        baseResult({
          verdict: 'regression',
          exitCode: 1,
          summary: 'regression: 1 gating finding(s), 1 gap(s)',
          findings: [finding({ whatUserExperiences: huge('EXPERIENCE'), fix: huge('FIX') })],
          coverage: {
            changedFiles: [],
            affected: [],
            unresolvedFiles: [],
            gaps: [{ ref: 'http://127.0.0.1:5173/jobs', state: 'not-covered', reason: huge('REASON') }],
            nothingToCheck: false,
          },
        }),
        { stopHookActive: false },
      );

      expect(decision.block).toBe(true);
      const notes = decision.message.match(/\[shortened, \d+ characters omitted\]/g) ?? [];
      expect(notes.length).toBe(3);
      // The start of each field survives, so the reader still learns the cause.
      expect(decision.message).toContain('experience: EXPERIENCE');
      expect(decision.message).toContain('fix: FIX');
      expect(decision.message).toContain('http://127.0.0.1:5173/jobs: REASON');
      // The frame still opens once and closes once, after every shortened piece.
      expect(decision.message.split('[BEGIN UNTRUSTED PAGE TEXT').length).toBe(2);
      expect(decision.message.split('[END UNTRUSTED PAGE TEXT]').length).toBe(2);
      expect(decision.message.trim().endsWith('[END UNTRUSTED PAGE TEXT]')).toBe(true);
      expect(decision.message.length).toBeLessThan(3_000);
    });

    it('shortens an oversized crash summary but keeps the verdict word and exit code whole', () => {
      const decision = evaluateStopDecision(
        baseResult({ verdict: null, exitCode: 4, summary: huge('unhandled error: boom') }),
        { stopHookActive: false },
      );

      expect(decision.message.startsWith('NO VERDICT: RUN FAILED (exit 4): ')).toBe(true);
      expect(decision.message).toContain('Gate summary: unhandled error: boom');
      expect(decision.message).toContain('characters omitted]');
      expect(decision.message.length).toBeLessThan(1_000);
    });

    it('keeps a group count whole when the rule name is cut', () => {
      const rule = `rule-${'r'.repeat(500)}`;
      const decision = evaluateStopDecision(
        baseResult({
          verdict: 'regression',
          exitCode: 1,
          summary: 'regression: 3 gating finding(s)',
          findings: [
            finding({ rule, elementKey: 'a' }),
            finding({ rule, elementKey: 'b' }),
            finding({ rule, elementKey: 'c' }),
          ],
        }),
        { stopHookActive: false },
      );

      expect(decision.message).toMatch(/Rule: rule-r+ \[shortened, \d+ characters omitted\] \(×3\)/);
    });

    it('leaves a normal message untouched: no note appears', () => {
      const decision = evaluateStopDecision(
        baseResult({
          verdict: 'regression',
          exitCode: 1,
          summary: 'regression: 1 gating finding(s)',
          findings: [finding({})],
        }),
        { stopHookActive: false },
      );

      expect(decision.message).not.toContain('shortened');
      expect(decision.message).toContain('experience: Low contrast text');
      expect(decision.message).toContain('fix: Raise contrast to 4.5:1');
    });

    it('stays under 13,000 characters at the default noise budget with every field oversized', () => {
      // Worst case at the default budget: five rule groups shown, each with an oversized rule,
      // screen, experience, and fix; every gap state present with an oversized ref and reason,
      // plus one unrecognized state; and an oversized summary.
      const findings = Array.from({ length: 8 }, (_, index) =>
        finding({
          rule: huge(`rule-${index}`),
          screenId: huge(`screen-${index}`),
          whatUserExperiences: huge(`experience-${index}`),
          fix: huge(`fix-${index}`),
          elementKey: `k-${index}`,
        }),
      );
      const states = ['capability-denied', 'skipped', 'not-covered', 'unresolved', 'mystery'] as const;
      const gaps = states.flatMap((state) => [
        { ref: huge(`ref-${state}`), state, reason: huge(`reason-${state}`) },
        { ref: huge(`ref-${state}-2`), state, reason: huge(`reason-${state}-2`) },
      ]) as unknown as Result['coverage']['gaps'];
      const decision = evaluateStopDecision(
        baseResult({
          verdict: 'regression',
          exitCode: 1,
          summary: huge('regression: 8 gating finding(s), 10 gap(s)'),
          findings,
          coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps, nothingToCheck: false },
        }),
        { stopHookActive: false },
      );

      expect(decision.block).toBe(true);
      expect(decision.message).toContain('Barriers:');
      expect(decision.message).toContain('for all 8 gating findings');
      // The budget the caps in bounded-text.ts are sized for. Measured worst case: about 12,500.
      expect(decision.message.length).toBeLessThan(13_000);
    });
  });

  it('frames page text and scrubs secret-looking values in block reasons', () => {
    const decision = evaluateStopDecision(
      baseResult({
        verdict: 'regression',
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
            whatUserExperiences: 'Error shown with token=secretvalue',
            why: 'token=secretvalue leaked from page',
            fix: 'Increase contrast',
            evidence: {},
            confidence: 'fail',
            elementKey: 'button-save',
            identityBasis: 'name',
            status: 'new',
          },
        ],
      }),
      { stopHookActive: false },
    );

    expect(decision.block).toBe(true);
    expect(decision.message).toContain('UNTRUSTED PAGE TEXT');
    expect(decision.message).not.toContain('secretvalue');
  });

  it('collapses findings over the noise budget with a show-all hint', () => {
    const findings = Array.from({ length: 6 }, (_, index) => ({
      rule: `rule-${index}`,
      layer: 'axe',
      severity: 'serious' as const,
      evidenceClass: 'deterministic' as const,
      screenId: 'clusters',
      elementPath: `button-${index}`,
      elementName: 'Save',
      role: 'button',
      whatUserExperiences: `problem ${index}`,
      why: 'because',
      fix: 'fix it',
      evidence: {},
      confidence: 'fail' as const,
      elementKey: `k-${index}`,
      identityBasis: 'name' as const,
      status: 'new' as const,
    }));
    const decision = evaluateStopDecision(
      baseResult({ verdict: 'regression', findings }),
      { stopHookActive: false },
    );

    expect(decision.block).toBe(true);
    expect(decision.message).toContain('Barriers:');
    expect(decision.message).toContain('usabl check --json');
    expect(decision.message).toContain('6 gating findings');
  });
});
