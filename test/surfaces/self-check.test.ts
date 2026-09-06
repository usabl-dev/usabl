import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import { parseCliArgs } from '../../src/surfaces/cli.js';
import { projectSelfCheck } from '../../src/surfaces/self-check.js';

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
    expect(crash.message).toContain('Gate summary: unhandled error: read ECONNRESET');
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

  it('follows the verdict line with what it means, then the gate summary', () => {
    const lines = projectSelfCheck(
      baseResult({ verdict: 'regression', exitCode: 1, summary: 'regression: 1 gating finding(s)' }),
    ).message.split('\n');

    expect(lines[1]).toBe('advisory: the stop hook is the gate.');
    expect(lines[2]).toBe('This change adds an accessibility barrier. It is blocked until fixed.');
    expect(lines[3]).toBe('Gate summary: regression: 1 gating finding(s)');
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
