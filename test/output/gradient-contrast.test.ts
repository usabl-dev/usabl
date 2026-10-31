import { describe, expect, it } from 'vitest';
import type { Draft, Finding, Result, ScreenScan, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { formatSummary } from '../../src/output/summary.js';
import { collapseFindingsByRule } from '../../src/output/noise-budget.js';
import { axeProvider } from '../../src/providers/axe/index.js';
import { run } from '../../src/run.js';
import { draftsOf, testConfig } from '../helpers.js';

function contrast(
  screenId: string,
  elementPath: string,
  messageKey: string | null,
  over: Partial<Finding> = {},
): Finding {
  return {
    rule: 'color-contrast',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId,
    elementPath,
    elementName: null,
    role: null,
    whatUserExperiences: 'Needs review: Elements must meet minimum color contrast ratio thresholds',
    why: 'why',
    fix: 'fix',
    evidence: messageKey === null ? {} : { extra: { axeData: { messageKey } } },
    confidence: 'unverified',
    elementKey: `${screenId}|color-contrast|struct:unknown:${elementPath}`,
    identityBasis: 'structural',
    status: 'carried',
    ...over,
  };
}

function resultWith(findings: Finding[], over: Partial<Result> = {}): Result {
  return {
    schemaVersion: 'usabl.result.v1',
    verdict: 'verified',
    summary: 'verified',
    screens: [],
    coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
    findings,
    receipt: null,
    dirtyGuardedPaths: [],
    exitCode: 0,
    accessibilityVerdict: 'verified',
    accessibilityExitCode: 0,
    paidDownCount: 0,
    floorHeadroom: [],
    floorUnconfirmed: [],
    ...over,
  };
}

const GROUP_LINE = /axe could not measure the color contrast of (\d+) element/u;

describe('formatSummary groups gradient contrast results per screen', () => {
  const findings = [
    contrast('clusters', '.btn-a', 'bgGradient'),
    contrast('clusters', '.btn-c', 'bgGradient'),
    contrast('settings', '.btn-s', 'bgGradient'),
    contrast('clusters', '.btn-b', 'bgGradient'),
    contrast('clusters', '.photo-text', 'bgImage'),
    contrast('clusters', '.low', 'bgGradient', { confidence: 'fail', whatUserExperiences: 'Low contrast' }),
  ];

  it('prints one entry per screen with the count, the reason, and what to check', () => {
    const out = formatSummary(resultWith(findings));
    const groupLines = out.split('\n').filter((line) => GROUP_LINE.test(line));

    expect(groupLines).toHaveLength(2);
    expect(groupLines[0]).toContain('[carried] clusters · axe/color-contrast (serious)');
    expect(groupLines[0]).toMatch(/of 3 elements, because each has a gradient background/u);
    expect(groupLines[1]).toContain('settings');
    expect(groupLines[1]).toMatch(/of 1 element, because it has a gradient background/u);
    expect(out).toContain('the lightest and the darkest part of the gradient');
  });

  it('lists every grouped element under its entry, sorted', () => {
    const out = formatSummary(resultWith(findings));

    expect(out).toContain('        elements (3):\n          .btn-a\n          .btn-b\n          .btn-c\n');
    expect(out).toContain('        elements (1):\n          .btn-s\n');
  });

  it('prints every element in full on its own line, however many there are', () => {
    const paths = Array.from(
      { length: 12 },
      (_, i) =>
        `#main-content > div.pf-v6-c-toolbar > div:nth-child(2) > button.pf-v6-c-button:nth-child(${String(i + 1)})`,
    );
    const out = formatSummary(resultWith(paths.map((path) => contrast('clusters', path, 'bgGradient'))));
    const lines = out.split('\n');
    const start = lines.indexOf('        elements (12):');

    expect(start).toBeGreaterThan(-1);
    expect(lines.slice(start + 1, start + 13)).toEqual([...paths].sort().map((path) => `          ${path}`));
    expect(out).not.toContain('shortened');
  });

  it('leaves every other contrast result as its own entry', () => {
    const out = formatSummary(resultWith(findings));

    expect(out.split('\n').filter((line) => line.includes('Low contrast'))).toHaveLength(1);
    expect(out.split('\n').filter((line) => line.includes('minimum color contrast ratio thresholds'))).toHaveLength(1);
  });

  it('keeps the heading count at the number of findings, so it still matches the gate', () => {
    const out = formatSummary(resultWith(findings));

    expect(out).toContain('recorded, not blocking: 6 finding(s)');
  });

  it('groups blocking and recorded results apart, so a group never mixes the two', () => {
    const out = formatSummary(
      resultWith(
        [
          contrast('clusters', '.new-a', 'bgGradient', { status: 'new' }),
          contrast('clusters', '.old-a', 'bgGradient'),
          contrast('clusters', '.old-b', 'bgGradient'),
        ],
        { verdict: 'not_covered', accessibilityVerdict: 'not_covered', exitCode: 3, accessibilityExitCode: 3 },
      ),
    );

    expect(out).toContain('barriers that block this run: 1 finding(s)');
    expect(out).toContain('[new] clusters · axe/color-contrast (serious): Needs review: axe could not measure the color contrast of 1 element');
    expect(out).toContain('[carried] clusters · axe/color-contrast (serious): Needs review: axe could not measure the color contrast of 2 elements');
  });

  it('prints the same groups whatever order the gradient results arrive in', () => {
    const others = findings.filter((f) => f.evidence.extra?.['axeData'] === undefined || f.confidence === 'fail' || f.elementPath === '.photo-text');
    const gradients = findings.filter((f) => !others.includes(f));

    expect(formatSummary(resultWith([...others, ...[...gradients].reverse()]))).toBe(
      formatSummary(resultWith([...others, ...gradients])),
    );
  });

  it('does not change the Result it prints', () => {
    const result = resultWith(findings);
    const before = structuredClone(result);

    formatSummary(result);

    expect(result).toEqual(before);
  });

  it('neutralizes page-derived element paths', () => {
    const out = formatSummary(resultWith([contrast('clusters', '.btn\u001b[2J', 'bgGradient')]));

    expect(out).not.toContain('\u001b');
    expect(out).toContain('elements (1):\n          .btn');
  });
});

describe('collapseFindingsByRule keeps gradient results apart', () => {
  it('never merges a gradient result with another contrast result of the same status', () => {
    const groups = collapseFindingsByRule([
      contrast('clusters', '.a', 'bgGradient'),
      contrast('clusters', '.b', 'bgGradient'),
      contrast('clusters', '.c', 'bgImage'),
    ]);

    expect(groups.map((group) => [group.rule, group.count, group.representative.elementPath]).sort()).toEqual([
      ['color-contrast', 1, '.c'],
      ['color-contrast', 2, '.a'],
    ]);
  });
});

describe('gradient wording changes no verdict', () => {
  const config: UsablConfig = testConfig();

  async function draftsFor(messageKey: string): Promise<Draft[]> {
    const deps = makeFakeDeps();
    const page = Object.assign(await deps.browser.open('http://127.0.0.1:5173/clusters'), {
      runAxe: async () => ({
        violations: [],
        incomplete: [
          {
            id: 'color-contrast',
            impact: 'serious' as const,
            description: 'Elements must meet minimum color contrast ratio thresholds',
            nodes: [
              { target: ['.btn-a'], any: [{ data: { messageKey } }] },
              { target: ['.btn-b'], any: [{ data: { messageKey } }] },
            ],
          },
        ],
        passes: [],
        inapplicable: [],
      }),
    });
    return draftsOf(
      await axeProvider.run({ page, screen: { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' }, config }),
    );
  }

  async function runWith(drafts: Draft[], floor: string | null): Promise<Result> {
    const scan: ScreenScan = {
      screenId: 'clusters',
      url: 'http://127.0.0.1:5173/clusters',
      stops: [{ index: 0, elementPath: '#save', announcement: [] }],
      drafts,
      gaps: [],
      applicability: [],
      reachedSelectorPresent: null,
    };
    const files: Record<string, string> = { 'usabl.config.json': '{}' };
    if (floor !== null) files['.usabl-evidence.json'] = floor;
    return run(
      makeFakeDeps({
        changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
        files,
        headContents: { ...files },
        scans: { clusters: scan },
      }),
      config,
    );
  }

  function floorOf(result: Result): string {
    return JSON.stringify({
      version: 3,
      entries: result.findings.map((f) => ({
        screenId: f.screenId,
        layer: f.layer,
        rule: f.rule,
        elementKey: f.elementKey,
        identityBasis: f.identityBasis,
        count: 1,
      })),
    });
  }

  function verdictOf(result: Result) {
    return {
      verdict: result.verdict,
      exitCode: result.exitCode,
      accessibilityVerdict: result.accessibilityVerdict,
      accessibilityExitCode: result.accessibilityExitCode,
      statuses: result.findings.map((f) => [f.elementKey, f.status, f.confidence]),
      receipt: result.receipt === null ? null : result.receipt.findingsSummary,
    };
  }

  it('gives the same verdict, exit code, statuses, and receipt counts as any other needs-review result', async () => {
    const gradient = await draftsFor('bgGradient');
    const image = await draftsFor('bgImage');

    const newGradient = await runWith(gradient, null);
    const newImage = await runWith(image, null);
    expect(verdictOf(newGradient)).toEqual(verdictOf(newImage));
    expect(newGradient.verdict).toBe('not_covered');

    const flooredGradient = await runWith(gradient, floorOf(newGradient));
    const flooredImage = await runWith(image, floorOf(newImage));
    expect(verdictOf(flooredGradient)).toEqual(verdictOf(flooredImage));
    expect(flooredGradient.verdict).toBe('verified');
  });
});
