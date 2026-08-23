import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import { ciRefusal, mergeChangedPaths, parseCliArgs, projectCli } from '../../src/surfaces/cli.js';

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

describe('parseCliArgs', () => {
  it('defaults to check command and baseline flags', () => {
    expect(parseCliArgs([])).toEqual({
      command: 'check',
      staticOnly: false,
      trustedRef: null,
      json: false,
      ci: false,
      configPath: 'usabl.config.json',
    });
  });

  it('parses all supported flags', () => {
    expect(
      parseCliArgs(['--static-only', '--trusted-ref', 'origin/main', '--json', '--ci', '--config', 'x.json']),
    ).toEqual({
      command: 'check',
      staticOnly: true,
      trustedRef: 'origin/main',
      json: true,
      ci: true,
      configPath: 'x.json',
    });
  });

  it('accepts comment command', () => {
    expect(parseCliArgs(['comment']).command).toBe('comment');
  });

  it('accepts bypass command', () => {
    expect(parseCliArgs(['bypass']).command).toBe('bypass');
  });

  it('accepts check command with flags after command', () => {
    expect(parseCliArgs(['check', '--ci'])).toEqual({
      command: 'check',
      staticOnly: false,
      trustedRef: null,
      json: false,
      ci: true,
      configPath: 'usabl.config.json',
    });
  });
});

describe('ciRefusal', () => {
  it('refuses ci mode without trusted ref', () => {
    const refusal = ciRefusal(parseCliArgs(['--ci']));
    expect(refusal).not.toBeNull();
    expect(refusal?.exitCode).toBe(2);
    expect(refusal?.message).toContain('--trusted-ref');
  });

  it('allows ci mode with trusted ref', () => {
    expect(ciRefusal(parseCliArgs(['--ci', '--trusted-ref', 'origin/main']))).toBeNull();
  });

  it('allows non-ci mode without trusted ref', () => {
    expect(ciRefusal(parseCliArgs([]))).toBeNull();
  });
});

describe('projectCli', () => {
  it('projects scrubbed regression text and json', () => {
    const projected = projectCli(
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
            whatUserExperiences: 'Low contrast text',
            why: 'token=super-secret-value',
            fix: 'Raise contrast to 4.5:1',
            evidence: {},
            confidence: 'fail',
            elementKey: 'k',
            identityBasis: 'name',
            status: 'new',
          },
        ],
      }),
    );

    expect(projected.exitCode).toBe(1);
    expect(projected.text).toContain('REGRESSION');
    expect(JSON.parse(projected.json).schemaVersion).toBe('usabl.result.v1');
    expect(projected.text).not.toContain('super-secret-value');
    expect(projected.json).not.toContain('super-secret-value');
  });

  it('projects idle headline when verdict is null', () => {
    const projected = projectCli(baseResult({ verdict: null, summary: 'nothing to check (no UI-touching files)' }));
    expect(projected.text).toContain('IDLE');
  });
});

describe('mergeChangedPaths', () => {
  it('returns unique sorted union and handles empties', () => {
    expect(
      mergeChangedPaths(
        ['src/z.ts', 'src/a.ts', 'src/a.ts'],
        ['src/b.ts', 'src/z.ts'],
      ),
    ).toEqual(['src/a.ts', 'src/b.ts', 'src/z.ts']);
    expect(mergeChangedPaths([], [])).toEqual([]);
  });
});
