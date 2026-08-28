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
    const regression = projectSelfCheck(baseResult({ verdict: 'regression' }));
    const idle = projectSelfCheck(baseResult({ verdict: null }));

    expect(regression.message).toContain('REGRESSION');
    expect(idle.message).toContain('IDLE');
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
