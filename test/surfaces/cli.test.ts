import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import {
  ciRefusal,
  mergeChangedPaths,
  parseCliArgs,
  projectCli,
} from '../../src/surfaces/cli.js';

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

describe('parseCliArgs', () => {
  it('defaults to check command and baseline flags', () => {
    expect(parseCliArgs([])).toEqual({
      command: 'check',
      staticOnly: false,
      html: false,
      docs: false,
      trustedRef: null,
      json: false,
      ci: false,
      configPath: 'usabl.config.json',
      selfCheck: false,
      force: false,
      enforceCheck: null,
      floorSubcommand: null,
      partial: false,
      driftSubcommand: null,
      installTarget: null,
      cursorStopHook: false,
    });
  });

  it('parses all supported flags', () => {
    expect(
      parseCliArgs([
        '--static-only',
        '--html',
        '--trusted-ref',
        'origin/main',
        '--json',
        '--ci',
        '--config',
        'x.json',
        '--self-check',
      ]),
    ).toEqual({
      command: 'check',
      staticOnly: true,
      html: true,
      docs: false,
      trustedRef: 'origin/main',
      json: true,
      ci: true,
      configPath: 'x.json',
      selfCheck: true,
      force: false,
      enforceCheck: null,
      floorSubcommand: null,
      partial: false,
      driftSubcommand: null,
      installTarget: null,
      cursorStopHook: false,
    });
  });

  it('parses --html for the docs command', () => {
    const parsed = parseCliArgs(['docs', '--html']);
    expect(parsed.command).toBe('docs');
    expect(parsed.html).toBe(true);
  });

  it('defaults html to false', () => {
    expect(parseCliArgs([]).html).toBe(false);
  });

  it('accepts comment command', () => {
    expect(parseCliArgs(['comment']).command).toBe('comment');
  });

  it('accepts bypass command', () => {
    expect(parseCliArgs(['bypass']).command).toBe('bypass');
  });

  it('accepts baseline command', () => {
    expect(parseCliArgs(['baseline']).command).toBe('baseline');
  });

  it('parses --partial for the baseline command', () => {
    const parsed = parseCliArgs(['baseline', '--partial']);
    expect(parsed.command).toBe('baseline');
    expect(parsed.partial).toBe(true);
  });

  it('defaults partial to false', () => {
    expect(parseCliArgs(['baseline']).partial).toBe(false);
  });

  it('parses floor prune as the floor command', () => {
    const parsed = parseCliArgs(['floor', 'prune']);
    expect(parsed.command).toBe('floor');
    expect(parsed.floorSubcommand).toBe('prune');
  });

  it('keeps floor as the command when no subcommand is given', () => {
    const parsed = parseCliArgs(['floor']);
    expect(parsed.command).toBe('floor');
    expect(parsed.floorSubcommand).toBeNull();
  });

  it('accepts check command with flags after command', () => {
    expect(parseCliArgs(['check', '--ci'])).toEqual({
      command: 'check',
      staticOnly: false,
      html: false,
      docs: false,
      trustedRef: null,
      json: false,
      ci: true,
      configPath: 'usabl.config.json',
      selfCheck: false,
      force: false,
      enforceCheck: null,
      floorSubcommand: null,
      partial: false,
      driftSubcommand: null,
      installTarget: null,
      cursorStopHook: false,
    });
  });

  it('parses drift routes as the drift command', () => {
    const parsed = parseCliArgs(['drift', 'routes']);
    expect(parsed.command).toBe('drift');
    expect(parsed.driftSubcommand).toBe('routes');
  });

  it('keeps drift as the command when no subcommand is given', () => {
    const parsed = parseCliArgs(['drift']);
    expect(parsed.command).toBe('drift');
    expect(parsed.driftSubcommand).toBeNull();
  });

  it('accepts enforce accessibility and policy subcommands', () => {
    expect(parseCliArgs(['enforce', 'accessibility']).command).toBe('enforce');
    expect(parseCliArgs(['enforce', 'accessibility']).enforceCheck).toBe('accessibility');
    expect(parseCliArgs(['enforce', 'policy', '--trusted-ref', 'origin/main']).enforceCheck).toBe(
      'policy',
    );
    expect(parseCliArgs(['enforce', 'policy', '--trusted-ref', 'origin/main']).trustedRef).toBe(
      'origin/main',
    );
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
