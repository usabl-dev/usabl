import { describe, expect, it } from 'vitest';
import type { CoverageGap, Finding, Result, ScreenScan, TranscriptStop } from '../../src/contracts/index.js';
import {
  COMMENT_BODY_LIMIT,
  GAPS_PER_STATE_CAP,
  projectPrComment,
  projectPrCommentWithin,
} from '../../src/surfaces/pr-comment.js';
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
    // limit and still opens with the verdict and the counts. Every string is longer than any field
    // cap, and the first lines of the gating findings alone come to about one and a half times the
    // limit (about 96,000 characters), so every cut tier is reached, the last one included. The sizes are kept that small so the test stays
    // fast on a loaded machine.
    const huge = 'x'.repeat(700);
    const findings: Finding[] = [
      ...Array.from({ length: 250 }, (_, index) =>
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
      ...Array.from({ length: 100 }, (_, index) => ({ ref: `${huge}${index}`, state: 'unresolved' as const, reason: huge })),
      ...Array.from({ length: 50 }, (_, index) => ({ ref: `cap-${index}`, state: 'capability-denied' as const, reason: huge })),
      ...Array.from({ length: 50 }, (_, index) => ({ ref: `odd-${index}`, state: 'someday' as never, reason: huge })),
    ];
    const screens = Array.from({ length: 10 }, (_, index) =>
      screen(`${huge}-${index}`, Array.from({ length: 25 }, (__, stopIndex) => stop(stopIndex, huge))),
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
      floorUnconfirmed: Array.from({ length: 40 }, (_, index) => ({ screenId: `${huge}${index}`, rules: [huge, huge], barriers: 3 })),
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
      expect(markdown).toContain('- deterministic: new 250 (250 failing, 0 unconfirmed), carried 0, waived 100, fixed 0');
      expect(markdown).toContain('- not evaluated: unresolved files 200, gaps 200');
      expect(markdown).toMatch(/items are not shown/);
      expect(markdown.split(UNTRUSTED_FRAME_START).length).toBe(markdown.split(UNTRUSTED_FRAME_END).length);
    }
  });

  it('names every coverage gap state even when gating first lines are cut', () => {
    // So many gating findings are listed one by one that their first lines alone pass the bound.
    // The first gap of each state is never cut, so a reader still learns which kinds of gap the
    // run had.
    const long = 'y'.repeat(300);
    const findings = Array.from({ length: 400 }, (_, index) =>
      finding({ screenId: `${long}-${index}`, rule: `${long}${index}`, layer: long, elementKey: `n-${index}` }),
    );
    const gaps: CoverageGap[] = [
      { ref: 'src/x.tsx', state: 'not-covered', reason: 'readiness did not hold' },
      { ref: 'src/y.tsx', state: 'unresolved', reason: 'no route reaches it' },
      { ref: 'src/y2.tsx', state: 'unresolved', reason: 'no route reaches it either' },
      { ref: 'cap', state: 'capability-denied', reason: 'no browser' },
      { ref: 'skip', state: 'skipped', reason: 'skipped by the plan' },
      { ref: 'odd', state: 'someday' as never, reason: 'a state usabl does not know' },
    ];
    const markdown = projectPrComment(
      result({ findings, coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps, nothingToCheck: false } }),
      { noiseBudget: { default: 1_000_000 } } as never,
    );

    expect(body(markdown).length).toBeLessThanOrEqual(COMMENT_BODY_LIMIT);
    // Gating first lines were cut, so the last tier was reached.
    expect(markdown).toMatch(/more gating findings not shown here/);
    const gapSection = markdown.slice(markdown.indexOf('### Coverage gaps'));
    for (const state of ['not-covered', 'unresolved', 'capability-denied', 'skipped']) {
      expect(gapSection).toContain(`(\`${state}\`)`);
    }
    expect(gapSection).toContain('ref: `odd`');
    // The second unresolved gap is not the first of its state, so it goes before any gating line.
    expect(gapSection).not.toContain('ref: `src/y2.tsx`');
  });

  it('says the comment was shortened to stay under the size usabl posts', () => {
    const long = 'y'.repeat(300);
    const findings = Array.from({ length: 400 }, (_, index) =>
      finding({ screenId: `${long}-${index}`, rule: `${long}${index}`, layer: long, elementKey: `n-${index}` }),
    );
    const markdown = projectPrComment(result({ findings }), { noiseBudget: { default: 1_000_000 } } as never);

    expect(markdown).toContain('_This comment was shortened to stay under the size usabl posts, so ');
    expect(markdown).not.toContain('GitHub accepts');
    // Only gating first lines were cut in this section, so the line names them as gating.
    expect(markdown).toMatch(/^- \d+ more gating findings not shown here, to keep this comment under the size usabl posts\.$/m);
  });

  it('uses the singular for one cut item', () => {
    // One screen of announcements, which is cut first, and gating findings whose first lines alone
    // pass the bound, so the one screen is cut and its section counts one item.
    const long = 'y'.repeat(300);
    const findings = Array.from({ length: 400 }, (_, index) =>
      finding({ screenId: `${long}-${index}`, rule: `${long}${index}`, layer: long, elementKey: `n-${index}` }),
    );
    const markdown = projectPrComment(
      result({ findings, screens: [screen('clusters', [stop(0, 'Clusters')])] }),
      { noiseBudget: { default: 1_000_000 } } as never,
    );

    expect(markdown).toMatch(/^- 1 more screen not shown here, to keep this comment under the size usabl posts\.$/m);
    expect(markdown).not.toMatch(/- 1 more screens /);
  });

  it('counts only the rule groups still shown in the collapsed hint after a cut', () => {
    // Each finding repeats once, so every rule group stands for two findings and the view is
    // collapsed by rule. The groups do not gate, so they are cut early, after the hint was worked
    // out from the noise budget.
    const long = 'w'.repeat(300);
    const findings = Array.from({ length: 400 }, (_, index) =>
      finding({ screenId: `${long}-${index}`, rule: `${long}${index}`, layer: long, status: 'carried', elementKey: `c-${index}`, whatUserExperiences: long, why: long, fix: long }),
    ).flatMap((entry, index) => [entry, { ...entry, elementKey: `c2-${index}` }]);
    const markdown = projectPrComment(
      result({ verdict: 'verified', exitCode: 0, findings }),
      { noiseBudget: { default: 1_000_000 } } as never,
    );

    const cut = Number(/^- (\d+) more rule groups not shown here/m.exec(markdown)?.[1]);
    expect(cut).toBeGreaterThan(0);
    expect(markdown).toContain(`(${400 - cut} of 400 rule groups shown)`);
    expect(markdown).not.toContain('400 rule groups; some rules repeat');
  });

  it('cuts the tiers in order, from the end of the comment within a tier', () => {
    // Two items of every tier, each with a word that appears only in it. The bound is lowered step
    // by step from the whole body to nothing, and at every step a cut item must have every item of
    // a lower tier cut before it, and every later item of its own tier.
    const gatingWhy = (index: number): string => `why-gate-${index}`;
    // The first pass reserves room for the cut lines, so it cuts a little more than it must. The
    // announcements are made longer than that reserve, so the step where only they are cut exists.
    const withNotes = (id: string, note: string): ScreenScan => ({
      ...screen(id, Array.from({ length: 10 }, (_, index) => stop(index, `stop ${index} on ${id} `.repeat(8)))),
      notes: [{ ref: note, reason: 'a check did not read a frame' }],
    });
    const everyTier = result({
      findings: [
        finding({ rule: 'gate-0', elementKey: 'g0', why: gatingWhy(0) }),
        finding({ rule: 'gate-1', elementKey: 'g1', why: gatingWhy(1) }),
        finding({ rule: 'rec-0', elementKey: 'r0', status: 'carried' }),
        finding({ rule: 'rec-1', elementKey: 'r1', status: 'carried' }),
        finding({ rule: 'adv-0', elementKey: 'a0', evidenceClass: 'preview' }),
        finding({ rule: 'adv-1', elementKey: 'a1', evidenceClass: 'preview' }),
      ],
      floorUnconfirmed: [
        { screenId: 'floor-0', rules: ['image-alt'], barriers: 1 },
        { screenId: 'floor-1', rules: ['image-alt'], barriers: 1 },
      ],
      coverage: {
        changedFiles: [],
        affected: [],
        unresolvedFiles: [],
        gaps: [
          { ref: 'gap-0', state: 'unresolved', reason: 'no route reaches it' },
          { ref: 'gap-1', state: 'unresolved', reason: 'no route reaches it' },
          { ref: 'gap-2', state: 'unresolved', reason: 'no route reaches it' },
        ],
        nothingToCheck: false,
      },
      screens: [withNotes('ann-0', 'note-0'), withNotes('ann-1', 'note-1')],
    });
    const config = { noiseBudget: { default: 1000 } } as never;
    // Each tier, lowest priority first, with its items in the order the comment prints them.
    const tiers: Array<{ name: string; items: string[] }> = [
      { name: 'announcement', items: ['#### `ann-0`', '#### `ann-1`'] },
      { name: 'note', items: ['ref: `note-0`', 'ref: `note-1`'] },
      { name: 'advisory', items: ['`axe/adv-0`', '`axe/adv-1`'] },
      { name: 'recorded', items: ['`axe/rec-0`', '`axe/rec-1`'] },
      { name: 'floor-notice', items: ['floor-0', 'floor-1'] },
      { name: 'gap', items: ['ref: `gap-1`', 'ref: `gap-2`'] },
      { name: 'gating-detail', items: [gatingWhy(0), gatingWhy(1)] },
      { name: 'gating', items: ['`axe/gate-0`', '`axe/gate-1`'] },
    ];

    const whole = projectPrCommentWithin(everyTier, config, Number.MAX_SAFE_INTEGER);
    for (const tier of tiers) {
      for (const marker of tier.items) {
        expect(whole, `${tier.name} item ${marker} is in the whole comment`).toContain(marker);
      }
    }

    // What the comment shows at one bound, checked against the order.
    const stateAt = (limit: number): { markdown: string; shown: boolean[][] } => {
      const markdown = projectPrCommentWithin(everyTier, config, limit);
      const shown = tiers.map((tier) => tier.items.map((marker) => markdown.includes(marker)));

      // Never cut: the verdict, the counts, and the first gap of each state.
      expect(markdown.split('\n')[1]).toBe('## usabl report: REGRESSION');
      expect(markdown).toContain('- not evaluated: unresolved files 0, gaps 3');
      expect(markdown).toContain('ref: `gap-0`');

      shown.forEach((items, tierIndex) => {
        items.forEach((isShown, itemIndex) => {
          if (isShown) return;
          // A cut item: every lower tier is cut, and so is every later item of its own tier.
          for (let lower = 0; lower < tierIndex; lower += 1) {
            expect(shown[lower]!.every((lowerShown) => !lowerShown), `${tiers[lower]!.name} cut before ${tiers[tierIndex]!.name}`).toBe(true);
          }
          for (let later = itemIndex + 1; later < items.length; later += 1) {
            expect(items[later], `${tiers[tierIndex]!.name} is cut from the end`).toBe(false);
          }
        });
      });
      return { markdown, shown };
    };
    const allCut = (shown: boolean[][], below: number): boolean =>
      shown.slice(0, below).every((items) => items.every((isShown) => !isShown));
    const allWhole = (shown: boolean[][], from: number): boolean =>
      shown.slice(from).every((items) => items.every((isShown) => isShown));

    // The order holds at evenly spaced bounds from the whole body down to nothing.
    const steps = 40;
    for (let step = 0; step <= steps; step += 1) {
      stateAt(Math.round(((whole.length + 1) * (steps - step)) / steps));
    }

    // For each tier, the largest bound at which every lower tier is cut. There, this tier and every
    // higher one must still be whole: each tier is reached on its own, in this order. The cut set
    // only grows as the bound shrinks, so a binary search finds that bound.
    expect(allWhole(stateAt(whole.length + 1).shown, 0)).toBe(true);
    for (let tierIndex = 1; tierIndex < tiers.length; tierIndex += 1) {
      let low = 0;
      let high = whole.length + 1;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (allCut(stateAt(middle).shown, tierIndex)) low = middle;
        else high = middle;
      }
      const boundary = stateAt(low).shown;
      expect(allCut(boundary, tierIndex), `every tier below ${tiers[tierIndex]!.name} is cut`).toBe(true);
      expect(allWhole(boundary, tierIndex), `${tiers[tierIndex]!.name} and every higher tier are whole`).toBe(true);
    }
    const lowest = stateAt(0).markdown;

    // The last tier: with no room at all, every item that can be cut is cut, and each section
    // and the note under the verdict say what went.
    for (const tier of tiers) {
      for (const marker of tier.items) {
        expect(lowest).not.toContain(marker);
      }
    }
    expect(lowest).toContain('_This comment was shortened to stay under the size usabl posts, so 14 items are not shown. Each section says what it left out.');
    expect(lowest).toContain('- 2 more gating findings not shown here, to keep this comment under the size usabl posts.');
    expect(lowest).toContain('- 2 more findings not shown here, to keep this comment under the size usabl posts.');
    expect(lowest).toContain('- 2 more notices not shown here');
    expect(lowest).toContain('- 2 more gaps not shown here');
    expect(lowest).toContain('- 2 more notes not shown here');
    expect(lowest).toContain('- 2 more screens not shown here');
    expect(lowest).toContain('usabl-result');
    expect(lowest.split(UNTRUSTED_FRAME_START).length).toBe(lowest.split(UNTRUSTED_FRAME_END).length);
  });

  it('says how many gating findings show only their first line once their detail is cut', () => {
    const long = 'y'.repeat(300);
    const findings = Array.from({ length: 400 }, (_, index) =>
      finding({ screenId: `${long}-${index}`, rule: `${long}${index}`, layer: long, elementKey: `n-${index}` }),
    );
    const markdown = projectPrComment(result({ findings }), { noiseBudget: { default: 1_000_000 } } as never);

    const note = /_This comment was shortened to stay under the size usabl posts, so (\d+) items are not shown, and (\d+) gating findings show only their first line\./.exec(markdown);
    expect(note).not.toBeNull();
    const cut = Number(note![1]);
    const firstLineOnly = Number(note![2]);
    expect(cut + firstLineOnly).toBe(400);
    expect(markdown).toContain(`- ${cut} more gating findings not shown here`);
    expect(markdown).toContain('- deterministic: new 400 (400 failing, 0 unconfirmed)');
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
