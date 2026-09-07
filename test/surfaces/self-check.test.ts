import { describe, expect, it } from 'vitest';
import type { Result, UsablConfig } from '../../src/contracts/index.js';
import { parseCliArgs } from '../../src/surfaces/cli.js';
import { projectSelfCheck } from '../../src/surfaces/self-check.js';
import { SELF_CHECK_MESSAGE_BUDGET } from '../../src/output/bounded-text.js';
import { testConfig } from '../helpers.js';

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

describe('projectSelfCheck', () => {
  it('always returns advisory exit code 0 and echoes verdict', () => {
    const verdicts: Array<Result['verdict']> = [
      'verified',
      'regression',
      'not_covered',
      'approval_required',
      null,
    ];

    for (const verdict of verdicts) {
      const projected = projectSelfCheck(baseResult({ verdict }));
      expect(projected.advisoryExitCode).toBe(0);
      expect(projected.verdict).toBe(verdict);
    }
  });

  it('prints advisory gate ownership in the message', () => {
    const projected = projectSelfCheck(baseResult({ verdict: 'regression' }));

    expect(projected.message).toContain('advisory: the stop hook is the gate.');
  });

  it('prints the verdict keyword and maps null to IDLE', () => {
    const regression = projectSelfCheck(baseResult({ verdict: 'regression', exitCode: 1 }));
    const idle = projectSelfCheck(
      baseResult({ verdict: null, summary: 'nothing to check (no UI-touching files)' }),
    );

    expect(regression.message.split('\n')[0]).toBe('usabl self-check: REGRESSION (exit 1)');
    expect(idle.message.split('\n')[0]).toBe('usabl self-check: NO VERDICT: IDLE (exit 0)');
    expect(idle.message.toLowerCase()).not.toContain('verified');
  });

  it('names a failed run as RUN FAILED, never as IDLE and never as verified', () => {
    const crash = projectSelfCheck(
      baseResult({ verdict: null, exitCode: 4, summary: 'unhandled error: read ECONNRESET' }),
    );
    const lines = crash.message.split('\n');

    expect(lines[0]).toBe('usabl self-check: NO VERDICT: RUN FAILED (exit 4)');
    expect(crash.message).not.toContain('IDLE');
    expect(crash.message.toLowerCase()).not.toContain('verified');
    expect(crash.message).toContain('engine summary: unhandled error: read ECONNRESET');
  });

  it('shortens an oversized experience and fix with a visible note and keeps one frame', () => {
    const huge = (seed: string) => `${seed} ${'x'.repeat(50_000)}`;
    const projected = projectSelfCheck(
      baseResult({
        verdict: 'regression',
        exitCode: 1,
        summary: 'regression: 1 gating finding(s)',
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
      }),
    );

    const notes = projected.message.match(/\[shortened, \d+ characters omitted\]/g) ?? [];
    expect(notes.length).toBe(2);
    expect(projected.message).toContain('experience: EXPERIENCE');
    expect(projected.message).toContain('fix: FIX');
    expect(projected.message.split('[END UNTRUSTED PAGE TEXT]').length).toBe(2);
    expect(projected.message.length).toBeLessThan(2_000);
  });

  // Over every cap, and small enough that two hundred findings scrub quickly.
  const huge = (seed: string) => `${seed} ${'x'.repeat(2_000)}`;
  const oversizedFindings = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      rule: huge(`rule-${index}`),
      layer: huge(`layer-${index}`),
      severity: 'serious' as const,
      evidenceClass: 'deterministic' as const,
      screenId: huge(`screen-${index}`),
      elementPath: 'button',
      elementName: 'Save',
      role: 'button',
      whatUserExperiences: huge(`experience-${index}`),
      why: '',
      fix: huge(`fix-${index}`),
      evidence: {},
      confidence: 'fail' as const,
      elementKey: `k-${index}`,
      identityBasis: 'name' as const,
      status: 'new' as const,
      // No file, two candidates: the longest source form this surface prints per group.
      appSource: { tier: 'coverage' as const, file: null, line: null, candidates: [huge(`cand-${index}-a`), huge(`cand-${index}-b`)] },
    }));
  const states = ['capability-denied', 'skipped', 'not-covered', 'unresolved', 'mystery'] as const;
  const oversizedGaps = states.flatMap((state) => [
    { ref: huge(`ref-${state}`), state, reason: huge(`reason-${state}`) },
    { ref: huge(`ref-${state}-2`), state, reason: huge(`reason-${state}-2`) },
  ]) as unknown as Result['coverage']['gaps'];

  it('fits the whole message in its budget at the default noise budget with every field oversized, dropping nothing', () => {
    // Worst case at the default budget: five rule groups shown, each with an oversized rule,
    // screen, layer, experience, fix, and candidate list; every gap state present with an
    // oversized ref and reason, plus one unrecognized state; and an oversized summary.
    const projected = projectSelfCheck(
      baseResult({
        verdict: 'regression',
        exitCode: 1,
        summary: huge('regression: 8 gating finding(s), 10 gap(s)'),
        findings: oversizedFindings(8),
        coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: oversizedGaps, nothingToCheck: false },
      }),
    );

    expect(projected.message).toContain('Barriers:');
    expect(projected.message.length).toBeLessThanOrEqual(SELF_CHECK_MESSAGE_BUDGET);
    expect(projected.message).not.toContain('shortened to fit');
    expect(projected.message.split('[END UNTRUSTED PAGE TEXT]').length).toBe(2);
    for (const state of states) {
      expect(projected.message).toContain(`- [${state === 'mystery' ? 'unrecognized' : state}], and 1 more with this state: ref-${state}`);
    }
    expect(projected.message.match(/^screen \(rule-\d/gm)?.length).toBe(5);
    expect(projected.message.match(/^candidates \(rule-\d/gm)?.length).toBe(5);
  });

  it('holds the message budget as a real bound when an operator raises the noise budget', () => {
    const findings = oversizedFindings(200);
    // At 20 groups the headlines fit and the frame survives with fewer pieces. At 200 the
    // headlines alone exceed the budget, so every piece goes and the frame is absent rather
    // than broken.
    for (const budget of [20, 200]) {
      const config: UsablConfig = { ...testConfig(), noiseBudget: { default: budget } };
      const projected = projectSelfCheck(
        baseResult({ verdict: 'regression', exitCode: 1, summary: huge('regression: 200 gating finding(s)'), findings }),
        config,
      );

      const lines = projected.message.split('\n');
      const opens = projected.message.split('[BEGIN UNTRUSTED PAGE TEXT').length - 1;
      const closes = projected.message.split('[END UNTRUSTED PAGE TEXT]').length - 1;
      expect(projected.message.length).toBeLessThanOrEqual(SELF_CHECK_MESSAGE_BUDGET);
      expect(lines[0]).toBe('usabl self-check: REGRESSION (exit 1)');
      expect(lines[1]).toBe('advisory: the stop hook is the gate.');
      // The summary piece opens the frame and is never dropped, even when every other piece is.
      expect(projected.message).toContain('engine summary: regression: 200 gating finding(s)');
      expect(opens).toBe(closes);
      expect(opens).toBeLessThanOrEqual(1);
      if (budget === 20) {
        expect(opens).toBe(1);
      }
      expect(lines.at(-1)).toMatch(/^\[shortened to fit the message budget, \d+ line\(s\) omitted/);
    }
  });

  it('follows the verdict line with what it means, then the gate summary', () => {
    const lines = projectSelfCheck(
      baseResult({ verdict: 'regression', exitCode: 1, summary: 'regression: 1 gating finding(s)' }),
    ).message.split('\n');

    expect(lines[1]).toBe('advisory: the stop hook is the gate.');
    expect(lines[2]).toBe('This change adds an accessibility barrier. It is blocked until fixed.');
    // The gate's summary is free text, so it opens the frame rather than sitting in the scaffold.
    expect(lines[3]!.startsWith('[BEGIN UNTRUSTED PAGE TEXT')).toBe(true);
    expect(lines[4]).toBe('engine summary: regression: 1 gating finding(s)');
  });

  it('frames page text and scrubs secrets before egress', () => {
    const projected = projectSelfCheck(
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
            whatUserExperiences: 'token=SECRETPOISON leaked from page',
            why: 'token=SECRETPOISON in details',
            fix: 'raise contrast',
            evidence: {},
            confidence: 'fail',
            elementKey: 'k',
            identityBasis: 'name',
            status: 'new',
          },
        ],
      }),
    );

    expect(projected.message).toContain('BEGIN UNTRUSTED PAGE TEXT');
    expect(projected.message).toContain('END UNTRUSTED PAGE TEXT');
    expect(projected.message).not.toContain('SECRETPOISON');
  });
});

describe('parseCliArgs self-check flag', () => {
  it('enables self-check on check command', () => {
    expect(parseCliArgs(['check', '--self-check']).selfCheck).toBe(true);
  });

  it('defaults self-check to false', () => {
    expect(parseCliArgs(['check']).selfCheck).toBe(false);
  });
});
