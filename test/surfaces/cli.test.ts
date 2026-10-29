import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import {
  ciRefusal,
  localApprovalNextSteps,
  mergeChangedPaths,
  parseCliArgs,
  projectCli,
} from '../../src/surfaces/cli.js';
import { parseResultJson } from '../../src/surfaces/policy-enforce.js';

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
  floorUnconfirmed: [],
  ...over,
});

describe('parseCliArgs', () => {
  it('defaults to check command and baseline flags', () => {
    expect(parseCliArgs([])).toEqual({
      command: 'check',
      staticOnly: false,
      html: false,
      all: false,
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
      unconfirmed: false,
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
      all: false,
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
      unconfirmed: false,
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

  it('parses --all for the docs command and defaults it to false', () => {
    expect(parseCliArgs(['docs', '--all']).all).toBe(true);
    expect(parseCliArgs(['docs']).all).toBe(false);
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
      all: false,
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
      unconfirmed: false,
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

  it('drops the query and the fragment of every screen url from the text and the JSON', () => {
    // A configured url can carry a preview token in its query. The CLI output and the JSON
    // Result are what CI publishes, so they lose it the way checkPage output already does.
    const url = 'http://127.0.0.1:5173/clusters?preview=SECRETPOISON#state=SECRETPOISON';
    const raw = baseResult({
      verdict: 'not_covered',
      exitCode: 3,
      accessibilityVerdict: 'not_covered',
      accessibilityExitCode: 3,
      screens: [
        { screenId: 'clusters', url, stops: [], drafts: [], gaps: [], applicability: [], reachedSelectorPresent: null },
      ],
      coverage: {
        changedFiles: ['src/Clusters.tsx'],
        affected: [{ screenId: 'clusters', url, provenance: 'manual' }],
        unresolvedFiles: [],
        gaps: [{ ref: url, state: 'not-covered', reason: `timeout loading ${url}` }],
        nothingToCheck: false,
      },
    });
    const projected = projectCli(raw);

    expect(projected.text).not.toContain('SECRETPOISON');
    expect(projected.json).not.toContain('SECRETPOISON');
    const parsed = parseResultJson(JSON.parse(projected.json));
    expect(parsed.screens[0]?.url).toBe('http://127.0.0.1:5173/clusters');
    expect(parsed.coverage.affected[0]?.url).toBe('http://127.0.0.1:5173/clusters');
    expect(parsed.coverage.gaps[0]?.ref).toBe('http://127.0.0.1:5173/clusters');
    expect(projected.text).toContain('http://127.0.0.1:5173/clusters');
    // The raw Result keeps the url as written, for the overlay and for receipts.
    expect(raw.screens[0]?.url).toBe(url);
  });

  it('projects idle headline when verdict is null', () => {
    const projected = projectCli(
      baseResult({
        verdict: null,
        summary: 'nothing to check (no UI-touching files)',
        coverage: { ...baseResult({}).coverage, nothingToCheck: true },
      }),
    );
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

describe('localApprovalNextSteps', () => {
  const approval = (over: Partial<Result>): Result =>
    baseResult({
      verdict: 'approval_required',
      summary: 'approval required: 2 guarded path(s) changed',
      dirtyGuardedPaths: ['usabl.config.json', 'usabl.routes.json'],
      exitCode: 2,
      ...over,
    });

  it('tells a first-run user to commit the new policy files and how to get the report', () => {
    const lines = localApprovalNextSteps(
      approval({ coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true } }),
    );
    const text = lines.join('\n');
    expect(text).toContain('next: usabl trusts policy files only after they are committed.');
    expect(text).toContain('commit them');
    expect(text).toContain('usabl baseline');
    expect(text).toContain('accessibility barriers');
    expect(text).not.toMatch(/\u2014|--(?!\w)/);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('says the touched screens were still scanned when they were', () => {
    const text = localApprovalNextSteps(
      approval({
        screens: [
          {
            screenId: 'home',
            url: 'http://127.0.0.1:5173/',
            stops: [],
            drafts: [],
            gaps: [],
            applicability: [],
            reachedSelectorPresent: null,
            reachedWhenSelector: null,
          },
        ],
      }),
    ).join('\n');
    expect(text).toContain('commit them');
    expect(text).toContain('were still scanned');
    expect(text).not.toContain('usabl baseline');
  });

  const scanOf = (screenId: string, gaps: Result['screens'][number]['gaps']): Result['screens'][number] => ({
    screenId,
    url: `http://127.0.0.1:59999/${screenId}`,
    stops: [],
    drafts: [],
    gaps,
    applicability: [],
    reachedSelectorPresent: null,
    reachedWhenSelector: null,
  });
  const openFailure = (screenId: string): Result['screens'][number]['gaps'][number] => ({
    ref: `http://127.0.0.1:59999/${screenId}`,
    state: 'not-covered',
    reason: 'screen failed to open: nothing answered at http://127.0.0.1:59999/',
  });

  it('says no screen was measured when no touched screen opened', () => {
    const failed = scanOf('home', [openFailure('home')]);
    const lines = localApprovalNextSteps(
      approval({
        screens: [failed],
        coverage: { changedFiles: ['src/Home.tsx'], affected: [], unresolvedFiles: [], gaps: failed.gaps, nothingToCheck: false },
        accessibilityVerdict: 'not_covered',
        accessibilityExitCode: 3,
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('commit them');
    expect(text).not.toContain('were still scanned');
    expect(text).not.toContain('were scanned');
    expect(text).toContain('no screen was measured');
    expect(text).toContain('"not evaluated"');
    expect(text).not.toMatch(/\u2014|--(?!\w)/);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('counts the touched screens that opened and the ones that did not', () => {
    const failed = scanOf('settings', [openFailure('settings')]);
    const lines = localApprovalNextSteps(
      approval({
        screens: [scanOf('home', []), failed],
        coverage: { changedFiles: ['src/Home.tsx'], affected: [], unresolvedFiles: [], gaps: failed.gaps, nothingToCheck: false },
        accessibilityVerdict: 'not_covered',
        accessibilityExitCode: 3,
      }),
    );
    const text = lines.join('\n');
    expect(text).not.toContain('were still scanned');
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('1 of the 2 screens this change touches was scanned.');
    expect(flat).toContain('Any accessibility barriers found there are listed above.');
    expect(flat).toContain('1 screen did not open or was not fully measured.');
    expect(text).toContain('"not evaluated"');
    expect(text).not.toMatch(/\u2014|--(?!\w)/);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('adds nothing for any other verdict', () => {
    expect(localApprovalNextSteps(baseResult({}))).toEqual([]);
    expect(localApprovalNextSteps(baseResult({ verdict: 'regression', exitCode: 1 }))).toEqual([]);
  });
});
