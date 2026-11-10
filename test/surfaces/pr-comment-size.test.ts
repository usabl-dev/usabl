import { describe, expect, it } from 'vitest';
import type { CoverageGap, Finding, Result, ScreenScan, TranscriptStop } from '../../src/contracts/index.js';
import { COMMENT_BODY_LIMIT, GAPS_PER_STATE_CAP, projectPrComment } from '../../src/surfaces/pr-comment.js';
import { UNTRUSTED_FRAME_END, UNTRUSTED_FRAME_START } from '../../src/surfaces/scrub.js';

// GitHub refuses a comment body over 65,536 characters, and the required check then fails with no
// comment to say why. These tests hold the bound on the body the CLI really prints.
const GITHUB_LIMIT = 65_536;

const finding = (over: Partial<Finding>): Finding => ({
  rule: 'color-contrast',
  layer: 'axe',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'clusters',
  elementPath: 'button#submit',
  elementName: 'Submit',
  role: 'button',
  whatUserExperiences: 'Low contrast text on the submit button makes the label hard to read.',
  why: 'Element has insufficient color contrast of 2.1 (foreground #777, background #fff).',
  fix: 'Raise the contrast of the label to at least 4.5:1 against its background.',
  evidence: {},
  confidence: 'fail',
  elementKey: 'k-submit',
  identityBasis: 'name',
  status: 'new',
  ...over,
});

const result = (over: Partial<Result>): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'regression',
  summary: 'regression',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 1,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  floorUnconfirmed: [],
  ...over,
});

function stop(index: number, text: string): TranscriptStop {
  return {
    index,
    elementPath: `main > nav > ul > li:nth-of-type(${index + 1}) > a.pf-v6-c-nav__link`,
    announcement: [
      { kind: 'name', text, fromTree: true, source: 'ax-tree' },
      { kind: 'role', text: 'link', fromTree: true, source: 'ax-tree' },
      { kind: 'live', text: 'Loaded 25 clusters in the table below', fromTree: true, source: 'ax-tree' },
    ],
  };
}

function screen(id: string, stops: TranscriptStop[]): ScreenScan {
  return { screenId: id, url: `http://127.0.0.1:5173/${id}`, stops, drafts: [], gaps: [], applicability: [], reachedSelectorPresent: null };
}

// The body the CLI writes: the projection and the newline after it.
const body = (markdown: string): string => `${markdown}\n`;

describe('pull request comment size', () => {
  it('keeps a wide run over 30 screens under the limit with the verdict and the counts', () => {
    // A shared layout file changed, so the wide blast rescans every screen. Each screen has a
    // full transcript and a spread of findings in every lane, with real-length text.
    const ids = Array.from({ length: 30 }, (_, index) => `screen-${String(index).padStart(2, '0')}`);
    const longName = 'Navigate to the cluster overview page for the selected managed cluster in this region';
    const screens = ids.map((id) => screen(id, Array.from({ length: 40 }, (_, index) => stop(index, `${longName} ${index}`))));
    const findings: Finding[] = ids.flatMap((id, screenIndex) => [
      ...Array.from({ length: 6 }, (_, index) =>
        finding({ screenId: id, rule: `rule-${index}`, elementKey: `${id}-new-${index}`, whatUserExperiences: `${longName} ${screenIndex}-${index}`.repeat(3) }),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        finding({ screenId: id, rule: `carried-${index}`, status: 'carried', elementKey: `${id}-carried-${index}` }),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        finding({ screenId: id, rule: `preview-${index}`, evidenceClass: 'preview', elementKey: `${id}-preview-${index}` }),
      ),
    ]);
    const gaps: CoverageGap[] = ids.map((id) => ({
      ref: `http://127.0.0.1:5173/${id}`,
      state: 'not-covered',
      reason: `the readiness signal for ${id} did not hold within 10000 ms; usabl could not confirm the screen rendered`,
    }));
    const wide = result({
      screens,
      findings,
      coverage: { changedFiles: ['src/Layout.tsx'], affected: [], unresolvedFiles: [], gaps, nothingToCheck: false },
    });

    const markdown = projectPrComment(wide, { noiseBudget: { default: 1000 } } as never);

    expect(body(markdown).length).toBeLessThanOrEqual(COMMENT_BODY_LIMIT);
    expect(COMMENT_BODY_LIMIT).toBeLessThan(GITHUB_LIMIT);
    expect(markdown.split('\n')[1]).toBe('## usabl report: REGRESSION');
    expect(markdown).toContain('- deterministic: new 180 (180 failing, 0 unconfirmed), carried 180, waived 0, fixed 0');
    expect(markdown).toContain('- not evaluated: unresolved files 0, gaps 30');
    // Content was cut, so the comment says how much and where the rest is.
    expect(markdown).toMatch(/items are not shown/);
    expect(markdown).toContain('usabl-result');
    // Every gating finding keeps its first line.
    for (const id of ids) {
      for (let index = 0; index < 6; index += 1) {
        expect(markdown).toContain(`\`${id}\` - \`axe/rule-${index}\``);
      }
    }
    // Every frame that opens also closes: nothing is cut inside one.
    expect(markdown.split(UNTRUSTED_FRAME_START).length).toBe(markdown.split(UNTRUSTED_FRAME_END).length);
  });

  it('keeps a pull request with 400 unmapped files under the limit with the verdict and the counts', () => {
    const files = Array.from({ length: 400 }, (_, index) => `src/features/area-${index}/components/WidgetPanel${index}.tsx`);
    const gaps: CoverageGap[] = files.map((file) => ({
      ref: file,
      state: 'unresolved',
      reason: `${file} matches uiFileGlobs but no route, surface, or wide-blast glob reaches it. Add it to a surface's files list in usabl.config.json, or import it from a routed page.`,
    }));
    const unmapped = result({
      verdict: 'not_covered',
      exitCode: 3,
      coverage: { changedFiles: files, affected: [], unresolvedFiles: files, gaps, nothingToCheck: false },
    });

    const markdown = projectPrComment(unmapped);

    expect(body(markdown).length).toBeLessThanOrEqual(COMMENT_BODY_LIMIT);
    expect(markdown.split('\n')[1]).toBe('## usabl report: NOT COVERED');
    expect(markdown).toContain('- not evaluated: unresolved files 400, gaps 400');
    // Gaps are bounded per state, and the rest are counted.
    const shownRefs = files.filter((file) => markdown.includes(`ref: \`${file}\``));
    expect(shownRefs.length).toBe(GAPS_PER_STATE_CAP);
    expect(markdown).toContain(`- ${400 - GAPS_PER_STATE_CAP} more \`unresolved\` gaps are not shown`);
    expect(markdown).toContain('usabl-result');
  });

  it('can never exceed the limit, whatever the Result carries', () => {
    // Every list is long and every carried string is far over any sane length. The noise budget is
    // raised so far that nothing collapses. Whatever the document says, the body stays under the
    // limit and still opens with the verdict and the counts.
    const huge = 'x'.repeat(1_500);
    const findings: Finding[] = [
      ...Array.from({ length: 400 }, (_, index) =>
        finding({
          screenId: `${huge}-${index}`,
          rule: `${huge}${index}`,
          layer: huge,
          elementKey: `new-${index}`,
          whatUserExperiences: huge,
          why: huge,
          fix: huge,
        }),
      ),
      ...Array.from({ length: 100 }, (_, index) => finding({ status: 'waived', rule: `w-${index}`, why: huge, elementKey: `w-${index}` })),
      ...Array.from({ length: 100 }, (_, index) => finding({ evidenceClass: 'model-judgment', rule: `m-${index}`, fix: huge, elementKey: `m-${index}` })),
    ];
    const gaps: CoverageGap[] = [
      ...Array.from({ length: 300 }, (_, index) => ({ ref: `${huge}${index}`, state: 'unresolved' as const, reason: huge })),
      ...Array.from({ length: 50 }, (_, index) => ({ ref: `cap-${index}`, state: 'capability-denied' as const, reason: huge })),
      ...Array.from({ length: 50 }, (_, index) => ({ ref: `odd-${index}`, state: 'someday' as never, reason: huge })),
    ];
    const screens = Array.from({ length: 40 }, (_, index) =>
      screen(`${huge}-${index}`, Array.from({ length: 30 }, (__, stopIndex) => stop(stopIndex, huge))),
    );
    const worst = result({
      schemaVersion: huge as never,
      verdict: 'approval_required',
      accessibilityVerdict: 'regression',
      summary: huge,
      screens,
      findings,
      coverage: { changedFiles: [], affected: [], unresolvedFiles: gaps.map((gap) => gap.ref), gaps, nothingToCheck: false },
      receipt: {
        schemaVersion: 2,
        historyHead: null,
        sourceTree: huge,
        baseRevision: null,
        policyHash: huge,
        runnerVersion: huge,
        scannerVersions: { axeCore: '4.13.0', playwright: '1.62.1', chromium: 'r' },
        surfaces: [],
        coverage: { checked: [], notCovered: [] },
        applicability: [],
        verdict: 'verified',
        findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
        activeWaivers: 0,
        mintedAt: huge,
      },
      floorUnconfirmed: Array.from({ length: 100 }, (_, index) => ({ screenId: `${huge}${index}`, rules: [huge, huge], barriers: 3 })),
      paidDownCount: 12,
      debt: {
        tracking: 'off',
        off: { cause: 'unreadable', detail: huge },
        historyHead: null,
        floorBarriers: 10,
        acceptedBarriers: 10,
        confirmedFixed: 0,
        fixedThisRun: 0,
        remaining: 10,
        oldestOpenDays: 3,
        intermittent: 0,
      },
    });

    for (const config of [undefined, { noiseBudget: { default: 1_000_000 } }]) {
      const markdown = projectPrComment(worst, config as never);

      expect(body(markdown).length).toBeLessThanOrEqual(COMMENT_BODY_LIMIT);
      expect(markdown.split('\n')[1]).toBe('## usabl report: APPROVAL REQUIRED');
      expect(markdown).toContain('Policy changed. Accessibility on this run: **REGRESSION**.');
      expect(markdown).toContain('- deterministic: new 400 (400 failing, 0 unconfirmed), carried 0, waived 100, fixed 0');
      expect(markdown).toContain('- not evaluated: unresolved files 400, gaps 400');
      expect(markdown).toMatch(/items are not shown/);
      expect(markdown.split(UNTRUSTED_FRAME_START).length).toBe(markdown.split(UNTRUSTED_FRAME_END).length);
    }
  });

  it('leaves an ordinary comment exactly as it was, with no note about cutting', () => {
    const small = result({
      findings: [finding({})],
      coverage: {
        changedFiles: ['src/a.tsx'],
        affected: [],
        unresolvedFiles: [],
        gaps: [{ ref: 'src/b.tsx', state: 'unresolved', reason: 'no route reaches it' }],
        nothingToCheck: false,
      },
    });

    const markdown = projectPrComment(small);

    expect(markdown).not.toMatch(/not shown/);
    expect(markdown).toContain('ref: `src/b.tsx`');
  });
});
