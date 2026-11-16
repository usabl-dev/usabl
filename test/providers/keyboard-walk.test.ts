import { describe, expect, it } from 'vitest';
import type {
  AxNode,
  Draft,
  FocusUnreadable,
  Page,
  ProviderContext,
  ProviderOutput,
  Step,
  UnreadableRegionListing,
  UnreadRegionName,
  WalkRecord,
} from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { isWalkReachGap, makeKeyboardWalkProvider } from '../../src/providers/keyboard-walk/index.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { draftsOf, gapsOf, testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };
const BODY_PATH = 'html > body:nth-child(2)';

interface ScriptedPageSpec {
  activePaths: string[];
  activeNodes: Array<AxNode | null>;
  announcements: string[][];
  unreadable?: Array<FocusUnreadable | null>;
  // The stop at which focus is on the document body. A real browser moves focus there after the
  // last control on the page, and that ends the walk.
  bodyAt?: number;
  // Where the Tab after the body stop lands, when it is not the first stop, as on a page whose script
  // dropped focus to the body in the middle of the page.
  afterBody?: string;
  // The paths of the open modal dialogs that hold the focused element, at each stop.
  modals?: string[][];
  // The browser's node id of the focused element at each stop, and of the element the Tab after the
  // body stop lands on. Left out, the page gives no node id, as the fake page does.
  keys?: Array<string | null>;
  afterBodyKey?: string;
  onTab?: () => void;
}

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = 0;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

function unnamedLinkPage(paths: string[]): ScriptedPageSpec {
  return {
    activePaths: paths,
    activeNodes: paths.map(() => ({ name: null, role: 'link', states: {} })),
    announcements: paths.map(() => []),
  };
}

// Named buttons at the given paths. A name here is page text, which no walk draft may carry.
function namedButtonPage(paths: string[], modals?: string[][]): ScriptedPageSpec {
  return {
    activePaths: paths,
    activeNodes: paths.map(() => ({ name: 'Page text that must not leak', role: 'button', states: {} })),
    announcements: paths.map(() => []),
    ...(modals === undefined ? {} : { modals }),
  };
}

// The same, with focus on the document body after the last path, as at the end of a real page.
function unnamedLinksThenBody(paths: string[]): ScriptedPageSpec {
  return { ...unnamedLinkPage([...paths, BODY_PATH]), bodyAt: paths.length };
}

function rules(drafts: Array<{ rule: string }>): string[] {
  return drafts.map((draft) => draft.rule);
}

// The reason of each gap the walk reported. A walk that was cut short reports one gap on the
// screen, never a draft, so nothing about it can be floored or carried.
const CUT_SHORT_LEAD = `on screen ${SCREEN.id}, the keyboard walk was cut short, so this screen is not covered.`;
const REGION_LEAD = `on screen ${SCREEN.id}, the keyboard walk could not read inside a region`;

function cutShort(output: Draft[] | ProviderOutput): string[] {
  const gaps = gapsOf(output).filter((gap) => !gap.reason.startsWith(REGION_LEAD));
  for (const gap of gaps) {
    expect(gap).toMatchObject({ ref: SCREEN.url, state: 'not-covered' });
    expect(gap.reason).toContain(CUT_SHORT_LEAD);
  }
  return gaps.map((gap) => gap.reason);
}

// The reason of each gap for a region the walk could not read into and walked past.
function unreadRegions(output: Draft[] | ProviderOutput): string[] {
  const gaps = gapsOf(output).filter((gap) => gap.reason.startsWith(REGION_LEAD));
  for (const gap of gaps) {
    expect(gap).toMatchObject({ ref: SCREEN.url, state: 'not-covered' });
  }
  return gaps.map((gap) => gap.reason);
}

function currentIndex(cursor: number, bodyAt?: number): number {
  if (cursor < 0) {
    return 0;
  }
  // Chromium moves focus to the body after the last control, and the next Tab goes back to the first
  // control. The scripted page does the same after the body stop.
  if (bodyAt !== undefined && cursor > bodyAt) {
    return (cursor - bodyAt - 1) % (bodyAt + 1);
  }
  return cursor;
}

function readAt<T>(values: T[], index: number, fallback: T): T {
  return values[index] ?? fallback;
}

async function makeScriptedPage(spec: ScriptedPageSpec): Promise<Page> {
  const deps = makeFakeDeps();
  const page = await deps.browser.open(SCREEN.url);
  let cursor = -1;
  const advance = () => {
    cursor += 1;
  };

  return Object.assign(page, {
    // Focus on the body with no starting point, as focusBody leaves a real page: the next Tab goes
    // to the first control.
    focusBody: async () => {
      cursor = -1;
    },
    tab: async () => {
      spec.onTab?.();
      advance();
    },
    press: async () => {
      advance();
    },
    click: async () => {
      advance();
    },
    activePath: async () =>
      spec.afterBody !== undefined && spec.bodyAt !== undefined && cursor > spec.bodyAt
        ? spec.afterBody
        : readAt(spec.activePaths, currentIndex(cursor, spec.bodyAt), ''),
    activeNode: async () => readAt(spec.activeNodes, currentIndex(cursor, spec.bodyAt), null),
    drainAnnouncements: async () => readAt(spec.announcements, currentIndex(cursor, spec.bodyAt), []),
    activeFocusUnreadable: async () => readAt(spec.unreadable ?? [], currentIndex(cursor, spec.bodyAt), null),
    activeModalDialogs: async () => readAt(spec.modals ?? [], currentIndex(cursor, spec.bodyAt), []),
    activeElementKey: async () =>
      spec.afterBodyKey !== undefined && spec.bodyAt !== undefined && cursor > spec.bodyAt
        ? spec.afterBodyKey
        : readAt(spec.keys ?? [], currentIndex(cursor, spec.bodyAt), null),
    activeElementIs: async (selector: string) => selector === 'body' && spec.bodyAt !== undefined && cursor === spec.bodyAt,
  });
}

function makeContext(page: Page): ProviderContext {
  return {
    page,
    screen: SCREEN,
    config: testConfig(),
  };
}

describe('keyboard walk StepRunner', () => {
  it('captures name and role tokens for one tab step', async () => {
    const runner = makeStepRunner();
    const page = await makeScriptedPage({
      activePaths: ['#submit'],
      activeNodes: [{ name: 'Submit', role: 'button', states: {} }],
      announcements: [[]],
    });

    const stops = await runner.run(page, [{ do: 'tab' }]);

    expect(stops).toHaveLength(1);
    expect(stops[0]).toEqual({
      index: 0,
      elementPath: '#submit',
      announcement: [
        { kind: 'name', text: 'Submit', fromTree: true, source: 'ax-tree' },
        { kind: 'role', text: 'button', fromTree: true, source: 'ax-tree' },
      ],
    });
  });

  it('captures live tokens after activate when live-region text is drained', async () => {
    const runner = makeStepRunner();
    const page = await makeScriptedPage({
      activePaths: ['#delete'],
      activeNodes: [null],
      announcements: [['Cluster deleted successfully']],
    });

    const stops = await runner.run(page, [{ do: 'activate' }]);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.announcement).toEqual([
      {
        kind: 'live',
        text: 'Cluster deleted successfully',
        fromTree: false,
        source: 'attribute',
      },
    ]);
  });

  it('records on the stop why the focused element cannot be read', async () => {
    const runner = makeStepRunner();
    const page = await makeScriptedPage({
      activePaths: ['x-host'],
      activeNodes: [null],
      announcements: [[]],
      unreadable: ['closed-shadow-root'],
    });

    const stops = await runner.run(page, [{ do: 'tab' }]);

    expect(stops).toEqual([{ index: 0, elementPath: 'x-host', announcement: [], focusUnreadable: 'closed-shadow-root' }]);
  });

  it('records on the stop that the body has focus, whatever the path of the body is', async () => {
    const runner = makeStepRunner();
    const page = await makeScriptedPage({ activePaths: ['#save', '#app'], activeNodes: [null, null], announcements: [[], []], bodyAt: 1 });

    const stops = await runner.run(page, [{ do: 'tab' }, { do: 'tab' }]);

    expect(stops.map((stop) => [stop.elementPath, stop.onBody])).toEqual([
      ['#save', undefined],
      ['#app', true],
    ]);
  });

  it('throws when a step kind is unknown', async () => {
    const runner = makeStepRunner();
    const page = await makeScriptedPage({
      activePaths: ['#anything'],
      activeNodes: [{ name: 'Anything', role: 'button', states: {} }],
      announcements: [[]],
    });
    const steps: Step[] = [{ do: 'wave-hands' }];

    await expect(runner.run(page, steps)).rejects.toThrow('unknown step kind: wave-hands');
  });
});

describe('makeKeyboardWalkProvider', () => {
  it('emits unverified draft when activeNode is null at a tab stop', async () => {
    // Focus reaches the body after the one stop, so the walk ends complete and this case reads
    // only the detection behavior, never the separate disclosure a cut-short walk owes the operator.
    const provider = makeKeyboardWalkProvider({ tabCap: 5 });
    const page = await makeScriptedPage({
      activePaths: ['#mystery-focus', BODY_PATH],
      activeNodes: [null, null],
      announcements: [[], []],
      bodyAt: 1,
    });

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      rule: 'keyboard-walk-unconfirmed-focus',
      layer: 'walk',
      severity: 'serious',
      evidenceClass: 'deterministic',
      screenId: SCREEN.id,
      elementPath: '#mystery-focus',
      elementName: null,
      role: null,
      whatUserExperiences:
        'A focusable element exists but its accessible role and name cannot be determined.',
      why: 'Keyboard users reach this element but AT cannot announce what it is.',
      fix: 'Give the element a semantic HTML role or an explicit ARIA role, plus an accessible name.',
      // The row of the element the walk focused, read at the stop. The scripted page has no table.
      evidence: { extra: { rowRead: { kind: 'none' } } },
      confidence: 'unverified',
    });
  });

  it('stops without a finding when Tab returns focus to the document body', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 1 });
    const page = await makeScriptedPage({
      activePaths: ['html > body:nth-child(2)'],
      activeNodes: [null],
      announcements: [[]],
    });
    page.activeElementIs = async (selector) => selector === 'body';

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(drafts).toEqual([]);
  });

  it('emits fail draft for unnamed interactive role reached by Tab', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 5 });
    const page = await makeScriptedPage({
      activePaths: ['#empty-link', BODY_PATH],
      activeNodes: [{ name: null, role: 'link', states: {} }, null],
      announcements: [[], []],
      bodyAt: 1,
    });

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      rule: 'keyboard-walk-unnamed-interactive',
      layer: 'walk',
      severity: 'serious',
      evidenceClass: 'deterministic',
      screenId: SCREEN.id,
      elementPath: '#empty-link',
      elementName: null,
      role: 'link',
      whatUserExperiences:
        'An interactive element has no accessible name; screen-reader users hear only the role.',
      why: 'A link reached via Tab has no accessible name in the AX tree.',
      fix: 'Add aria-label or visible text to the element.',
      evidence: {
        role: { value: 'link', source: 'ax-tree', fromTree: true },
        extra: { rowRead: { kind: 'none' } },
      },
      confidence: 'fail',
    });
  });

  it('stops on focus cycles so tab walk does not hang', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 5 });
    const page = await makeScriptedPage({
      activePaths: ['#same-path', '#same-path', '#same-path', '#same-path', '#same-path', '#same-path'],
      activeNodes: [
        { name: null, role: 'link', states: {} },
        { name: null, role: 'link', states: {} },
        { name: null, role: 'link', states: {} },
        { name: null, role: 'link', states: {} },
        { name: null, role: 'link', states: {} },
        { name: null, role: 'link', states: {} },
      ],
      announcements: [[], [], [], [], [], []],
    });

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(drafts.length).toBeLessThanOrEqual(5);
  });

  it('gives every run its own wall-clock budget when one provider walks several screens', async () => {
    const clock = makeClock();
    const provider = makeKeyboardWalkProvider({ tabCap: 10, wallClockMs: 1_000, now: clock.now });

    // A real run opens the page, collects a transcript, and runs other providers before this walk,
    // and it does that again for every screen. All of that time is spent on one provider instance.
    clock.advance(30_000);
    const first = draftsOf(await provider.run(makeContext(await makeScriptedPage(unnamedLinksThenBody(['#a', '#b'])))));

    clock.advance(30_000);
    const second = draftsOf(await provider.run(makeContext(await makeScriptedPage(unnamedLinksThenBody(['#a', '#b'])))));

    expect(rules(first)).toEqual([
      'keyboard-walk-unnamed-interactive',
      'keyboard-walk-unnamed-interactive',
    ]);
    expect(second).toEqual(first);
  });

  it('discloses truncation when the wall-clock budget runs out mid walk', async () => {
    const clock = makeClock();
    const provider = makeKeyboardWalkProvider({ tabCap: 50, wallClockMs: 200, now: clock.now });
    const paths = Array.from({ length: 50 }, (_, i) => `#stop-${i}`);
    const page = await makeScriptedPage({
      ...unnamedLinkPage(paths),
      onTab: () => clock.advance(60),
    });

    const output = await provider.run(makeContext(page));
    const drafts = draftsOf(output);

    const walked = drafts.filter((d) => d.rule === 'keyboard-walk-unnamed-interactive');
    expect(walked.length).toBeGreaterThan(0);
    expect(walked.length).toBeLessThan(paths.length);

    expect(rules(drafts)).not.toContain('keyboard-walk-truncated');
    const reasons = cutShort(output);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/\d+ tab stop/);
    expect(reasons[0]).toContain('time budget');
  });

  it('discloses truncation when the walk stops at the tab cap', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 2 });
    const page = await makeScriptedPage(unnamedLinkPage(['#a', '#b', '#c', '#d']));

    const output = await provider.run(makeContext(page));
    const drafts = draftsOf(output);

    expect(rules(drafts)).toEqual(['keyboard-walk-unnamed-interactive', 'keyboard-walk-unnamed-interactive']);
    const reasons = cutShort(output);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('after 2 tab stop(s)');
  });

  it('reports no gap when the walk reaches the end of the page inside the budget', async () => {
    const clock = makeClock();
    const provider = makeKeyboardWalkProvider({ tabCap: 10, wallClockMs: 1_000, now: clock.now });
    const page = await makeScriptedPage({
      ...unnamedLinksThenBody(['#only-link']),
      onTab: () => clock.advance(10),
    });

    const output = await provider.run(makeContext(page));

    expect(rules(draftsOf(output))).toEqual(['keyboard-walk-unnamed-interactive']);
    expect(gapsOf(output)).toEqual([]);
  });

  it('reports no gap when the walk ends exactly at the stop cap with the walk complete', async () => {
    // Three controls and the body fill the cap of four stops. The Tab that confirms the end is not
    // a stop of its own.
    const provider = makeKeyboardWalkProvider({ tabCap: 4 });
    const page = await makeScriptedPage({ ...namedButtonPage(['#a', '#b', '#c', BODY_PATH]), bodyAt: 3 });

    const output = await provider.run(makeContext(page));

    expect(draftsOf(output)).toEqual([]);
    expect(gapsOf(output)).toEqual([]);
  });

  it('reports no gap when the walk ends on the document body', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(unnamedLinkPage(['html > body:nth-child(2)']));
    page.activeElementIs = async (selector) => selector === 'body';

    const output = await provider.run(makeContext(page));

    expect(draftsOf(output)).toEqual([]);
    expect(gapsOf(output)).toEqual([]);
  });

  it('confirms the end of the walk when one more Tab lands on any stop already walked', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({ ...namedButtonPage(['#a', '#b', '#c', BODY_PATH]), bodyAt: 3, afterBody: '#b' });

    expect(draftsOf(await provider.run(makeContext(page)))).toEqual([]);
  });

  it('accepts a path match alone only for the first stop walked when the browser gives node ids', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const spec = { ...namedButtonPage(['#a', '#b', '#c', BODY_PATH]), bodyAt: 3, keys: ['node-1', 'node-2', 'node-3', null] };

    // The same element at a stop already walked.
    const sameElement = await makeScriptedPage({ ...spec, afterBody: '#b', afterBodyKey: 'node-2' });
    expect(draftsOf(await provider.run(makeContext(sameElement)))).toEqual([]);

    // A new element at the path of the first stop, as a list that re-rendered puts there.
    const newFirst = await makeScriptedPage({ ...spec, afterBody: '#a', afterBodyKey: 'node-9' });
    expect(draftsOf(await provider.run(makeContext(newFirst)))).toEqual([]);

    // A new element at the path of a later stop is not the start of the focus order.
    const newLater = await makeScriptedPage({ ...spec, afterBody: '#b', afterBodyKey: 'node-9' });
    const laterOutput = await provider.run(makeContext(newLater));
    expect(draftsOf(laterOutput)).toEqual([]);
    expect(cutShort(laterOutput)).toHaveLength(1);
  });

  it('leaves focus on the body after a complete walk, so the next Tab lands on the first stop', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({ ...namedButtonPage(['#a', '#b', '#c', BODY_PATH]), bodyAt: 3 });

    expect(draftsOf(await provider.run(makeContext(page)))).toEqual([]);
    await page.tab();

    expect(await page.activePath()).toBe('#a');
  });

  it('discards what the Tab that confirms the end announced, so the next check does not hear it', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({ ...namedButtonPage(['#a', '#b', BODY_PATH]), bodyAt: 2 });
    // A capture that holds what each Tab caused until a drain: landing on the first control writes
    // into a live region, as a focus handler can.
    let pending: string[] = [];
    const tab = page.tab.bind(page);
    page.tab = async () => {
      await tab();
      if ((await page.activePath()) === '#a') {
        pending.push('Welcome back');
      }
    };
    page.drainAnnouncements = async () => {
      const texts = pending;
      pending = [];
      return texts;
    };

    expect(draftsOf(await provider.run(makeContext(page)))).toEqual([]);

    expect(await page.drainAnnouncements()).toEqual([]);
  });

  it('discloses truncation when one more Tab after the body lands on a control not yet walked', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({ ...namedButtonPage(['#a', BODY_PATH]), bodyAt: 1, afterBody: '#c' });

    const output = await provider.run(makeContext(page));

    expect(draftsOf(output)).toEqual([]);
    const reasons = cutShort(output);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(
      'After 1 tab stop(s), focus moved to the document body, but one more Tab did not go back to a control the keyboard walk had already reached. A script may have moved focus away from a control or stopped the Tab key, so the controls after that point may never have been walked.',
    );
  });

  // A script that focuses a body with a tabindex in the middle of the page leaves focus on the body,
  // and the next Tab starts from the body and lands on the first control, as at the real end of the
  // focus order. Read as the end, the controls after that point were never walked and the walk
  // read as complete.
  it('discloses truncation when a script put focus on the body itself in the middle of the page', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({ ...namedButtonPage(['#a', '#b', BODY_PATH]), bodyAt: 2, afterBody: '#a' });
    page.bodyHoldsFocus = async () => page.activeElementIs('body');

    const output = await provider.run(makeContext(page));

    expect(draftsOf(output)).toEqual([]);
    const reasons = cutShort(output);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(
      'After 2 tab stop(s), a script moved focus to the document body itself, so the next Tab starts again from the top of the page and the keyboard walk cannot tell where the focus order ends. The controls after that point may never have been walked.',
    );
    expect(reasons[0]).toContain(
      'Find the script on this screen that moves focus to the document body, so Tab moves through every control to the end of the page, then check the screen again.',
    );
    expect(Array.isArray(output) ? undefined : output.walk?.complete).toBe(false);
  });

  it('discloses truncation when the page cannot say whether the body itself has focus', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({ ...namedButtonPage(['#a', '#b', BODY_PATH]), bodyAt: 2, afterBody: '#a' });
    page.bodyHoldsFocus = async () => {
      throw new Error('the browser could not read focus');
    };

    const output = await provider.run(makeContext(page));
    expect(draftsOf(output)).toEqual([]);
    expect(cutShort(output)).toHaveLength(1);
  });

  it('still ends complete when Tab moved past the last control and no element holds focus', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({ ...namedButtonPage(['#a', '#b', BODY_PATH]), bodyAt: 2, afterBody: '#a' });
    page.bodyHoldsFocus = async () => false;

    const output = await provider.run(makeContext(page));
    expect(draftsOf(output)).toEqual([]);
    expect(gapsOf(output)).toEqual([]);
  });

  it('discloses truncation when one more Tab after the body leaves focus on the body', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({ ...namedButtonPage(['#a', BODY_PATH]), bodyAt: 1, afterBody: BODY_PATH });
    page.activeElementIs = async (selector) => selector === 'body' && (await page.activePath()) === BODY_PATH;

    const output = await provider.run(makeContext(page));
    expect(draftsOf(output)).toEqual([]);
    expect(cutShort(output)).toHaveLength(1);
  });

  it('discloses truncation when no stop was walked and one more Tab lands on a control', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({ ...namedButtonPage([BODY_PATH]), bodyAt: 0, afterBody: '#second' });

    const output = await provider.run(makeContext(page));

    expect(draftsOf(output)).toEqual([]);
    const reasons = cutShort(output);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('After 0 tab stop(s)');
  });

  // A closed shadow root or a frame from another origin gives every control inside it the path of
  // the host or the frame. Read as paths alone, the second control is a return to the first and
  // the walk ends as complete, with nothing said about the controls after it. Ending the walk there
  // instead left every control after the region unwalked, so a defect after it was never found.
  // The walk counts the region as one stop it could not read, keeps pressing Tab until focus is
  // back in content it can read, and walks on. The region is a gap of its own.
  for (const [reason, where, words] of [
    ['closed-shadow-root', 'into a closed shadow root', 'closed shadow root'],
    ['frame-unreadable', 'into a frame from another origin', 'frame from another origin'],
    ['focus-too-deep', 'deeper than the read follows', 'more shadow roots and frames'],
  ] as const) {
    it(`walks past the region when focus moves ${where}, and finds the defect after it`, async () => {
      const provider = makeKeyboardWalkProvider({ tabCap: 10 });
      const page = await makeScriptedPage({
        ...unnamedLinkPage(['#first', '#host', '#host', '#after', BODY_PATH]),
        unreadable: [null, reason, reason, null, null],
        bodyAt: 4,
      });

      const output = await provider.run(makeContext(page));
      const drafts = draftsOf(output);

      // The region itself gives no draft: the walk cannot read the control that has focus there.
      expect(drafts.map((draft) => draft.elementPath)).toEqual(['#first', '#after']);
      expect(rules(drafts)).toEqual(['keyboard-walk-unnamed-interactive', 'keyboard-walk-unnamed-interactive']);
      expect(cutShort(output)).toEqual([]);
      const regions = unreadRegions(output);
      expect(regions).toHaveLength(1);
      expect(regions[0]).toContain(words);
      expect(regions[0]).toContain('at tab stop 2');
      expect(regions[0]).toContain('by hand');
      expect(Array.isArray(output) ? undefined : output.walk?.complete).toBe(true);
    });
  }

  it('counts two regions in a row as two stops it could not read', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({
      ...namedButtonPage(['#first', '#frame-a', '#frame-b', '#frame-b', '#after', BODY_PATH]),
      unreadable: [null, 'frame-unreadable', 'frame-unreadable', 'frame-unreadable', null, null],
      bodyAt: 5,
      // A stop the walk cannot read has no node id, as in Chromium.
      keys: ['node-1', null, null, null, 'node-5', null],
    });

    const output = await provider.run(makeContext(page));

    expect(draftsOf(output)).toEqual([]);
    expect(cutShort(output)).toEqual([]);
    expect(unreadRegions(output)).toHaveLength(2);
  });

  it('ends the walk complete when the region is the first stop and the Tab after the body lands in it again', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({
      ...namedButtonPage(['#frame', '#frame', '#after', BODY_PATH]),
      unreadable: ['frame-unreadable', 'frame-unreadable', null, null],
      bodyAt: 3,
    });

    const output = await provider.run(makeContext(page));

    expect(cutShort(output)).toEqual([]);
    expect(unreadRegions(output)).toHaveLength(1);
    expect(Array.isArray(output) ? undefined : output.walk?.complete).toBe(true);
  });

  it('is cut short when focus does not come back out of a region within its bound', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 500 });
    const paths = ['#first', ...Array.from({ length: 300 }, () => '#widget')];
    const page = await makeScriptedPage({
      ...namedButtonPage(paths),
      unreadable: [null, ...Array.from({ length: 300 }, () => 'closed-shadow-root' as const)],
    });

    const output = await provider.run(makeContext(page));

    const reasons = cutShort(output);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('pressed Tab 100 times inside a region it cannot read, and focus did not come back out');
    // The walk stops at the bound, long before the stop cap.
    expect(Array.isArray(output) ? 0 : (output.walk?.stops.length ?? 0)).toBeLessThan(150);
  });

  it('reads a region it meets again after other stops as a cycle, never as a new region', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({
      ...namedButtonPage(['#first', '#frame', '#after', '#frame', '#later']),
      unreadable: [null, 'frame-unreadable', null, 'frame-unreadable', null],
    });

    const output = await provider.run(makeContext(page));

    expect(rules(draftsOf(output))).toEqual(['keyboard-walk-trap']);
    expect(cutShort(output)).toHaveLength(1);
  });

  // A focus trap: Tab from the second control goes back to the first, so focus never reaches the
  // body and the controls after the trap are never walked. Read as a completed cycle, the walk
  // reported nothing and the screen read as covered.
  it('reports a keyboard trap and a truncation gap when focus cycles without reaching the body', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(namedButtonPage(['#before', '#one', '#two', '#one', '#outside']));

    const output = await provider.run(makeContext(page));
    const drafts = draftsOf(output);

    expect(rules(drafts)).toEqual(['keyboard-walk-trap']);
    expect(drafts[0]).toEqual({
      rule: 'keyboard-walk-trap',
      layer: 'walk',
      severity: 'critical',
      evidenceClass: 'deterministic',
      screenId: SCREEN.id,
      elementPath: '#one',
      elementName: null,
      role: null,
      whatUserExperiences:
        'Keyboard focus is trapped in a group of controls. A keyboard user who presses Tab cannot leave the group and cannot reach the rest of the page.',
      why: 'Tab moved focus around a cycle of 2 control(s) and never reached the end of the page. This fails WCAG 2.1.2 No Keyboard Trap.',
      fix: 'Let Tab and Shift+Tab move focus out of this group to the controls before and after it. Keep focus inside a group only while it is an open modal dialog: a dialog element opened with showModal(), or an element with role dialog or alertdialog and aria-modal true.',
      evidence: { extra: { cycle: ['#one', '#two'], rowRead: { kind: 'none' } } },
      confidence: 'fail',
    });
    const reasons = cutShort(output);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(
      'After 3 tab stop(s), focus went back to a control the keyboard walk had already reached, without reaching the end of the page, so the controls after the trap were never walked.',
    );
    expect(JSON.stringify([drafts, gapsOf(output)])).not.toContain('Page text');
  });

  it('reports a control that keeps focus on every Tab as a trap of one stop', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(namedButtonPage(['#stuck', '#stuck', '#stuck']));

    const output = await provider.run(makeContext(page));
    const drafts = draftsOf(output);

    expect(rules(drafts)).toEqual(['keyboard-walk-trap']);
    expect(cutShort(output)).toHaveLength(1);
    expect(drafts[0]?.elementPath).toBe('#stuck');
    expect(drafts[0]?.evidence.extra?.['cycle']).toEqual(['#stuck']);
    expect(drafts[0]?.why).toContain('1 control(s)');
  });

  // An open modal dialog keeps focus inside itself on purpose. That is the expected behavior, not
  // a barrier, but the rest of the page behind the dialog was still never walked.
  it('ends with a gap and no trap when the cycle stays inside an open modal dialog', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(namedButtonPage(['#one', '#two', '#one'], [['#dialog'], ['#dialog'], ['#dialog']]));

    const output = await provider.run(makeContext(page));

    expect(draftsOf(output)).toEqual([]);
    const reasons = cutShort(output);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(
      'After 2 tab stop(s), focus went back to a control it had already reached, and every control in that cycle is inside one open modal dialog. Focus stayed inside the dialog, and the rest of the page was not walked.',
    );
    expect(reasons[0]).toContain('check the dialog on a screen of its own');
  });

  it('reads a cycle inside a modal dialog nested in another as staying inside the outer one', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(
      namedButtonPage(['#one', '#two', '#one'], [['#outer', '#outer >> #inner'], ['#outer'], ['#outer', '#outer >> #inner']]),
    );

    const output = await provider.run(makeContext(page));

    expect(draftsOf(output)).toEqual([]);
    const reasons = cutShort(output);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('modal dialog');
  });

  // Stops walked before the cycle began sit outside the dialog. Only the cycle is judged, so this
  // is still a cycle inside one modal dialog. A rule that judged every walked stop would call it a
  // keyboard trap.
  it('judges only the stops of the cycle, not the stops walked before it', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(namedButtonPage(['#before', '#one', '#two', '#one'], [[], ['#d'], ['#d'], ['#d']]));

    const output = await provider.run(makeContext(page));

    expect(draftsOf(output)).toEqual([]);
    const reasons = cutShort(output);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('After 3 tab stop(s)');
    expect(reasons[0]).toContain('inside one open modal dialog');
  });

  it('reports a trap when the modal dialog does not hold every stop of the cycle', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    // The first stop is before the cycle and outside the dialog. The cycle itself leaves it.
    const page = await makeScriptedPage(namedButtonPage(['#before', '#one', '#two', '#one'], [[], ['#dialog'], [], ['#dialog']]));

    const output = await provider.run(makeContext(page));
    const drafts = draftsOf(output);

    expect(rules(drafts)).toEqual(['keyboard-walk-trap']);
    expect(drafts[0]?.evidence.extra?.['cycle']).toEqual(['#one', '#two']);
    expect(cutShort(output)).toHaveLength(1);
  });

  it('reads a cycle in two different modal dialogs as a trap', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(namedButtonPage(['#one', '#two', '#one'], [['#first-dialog'], ['#second-dialog'], ['#first-dialog']]));

    const output = await provider.run(makeContext(page));

    expect(rules(draftsOf(output))).toEqual(['keyboard-walk-trap']);
    expect(cutShort(output)).toHaveLength(1);
  });

  it('reports the same trap draft on every run of the same page', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const spec = namedButtonPage(['#a', '#b', '#c', '#b']);

    const first = draftsOf(await provider.run(makeContext(await makeScriptedPage(spec))));
    const second = draftsOf(await provider.run(makeContext(await makeScriptedPage(spec))));

    expect(second).toEqual(first);
    expect(first[0]?.evidence.extra?.['cycle']).toEqual(['#b', '#c']);
  });
});

// A long table page has more Tab stops than the engine default allows. The budget of one screen is
// set in usabl.config.json, under keyboardWalk.perSurface, so the walk on that page can complete.
describe('the keyboard walk budget of one screen', () => {
  function contextWith(page: Page, perSurface: Record<string, { tabCap?: number; wallClockMs?: number }>): ProviderContext {
    return { page, screen: SCREEN, config: { ...testConfig(), keyboardWalk: { perSurface } } };
  }

  const longPage = (): ScriptedPageSpec => {
    const paths = Array.from({ length: 250 }, (_, i) => `#row-${i}`);
    return { ...namedButtonPage([...paths, BODY_PATH]), bodyAt: paths.length };
  };

  it('cuts a long page short at the default stop cap, and the gap names the setting for the CLI and for checkPage', async () => {
    const output = await makeKeyboardWalkProvider().run(makeContext(await makeScriptedPage(longPage())));

    const reasons = cutShort(output);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('reached its limit of 200 tab stops');
    expect(reasons[0]).toContain(`keyboardWalk.perSurface.${SCREEN.id}.tabCap in usabl.config.json`);
    expect(reasons[0]).toContain('the tabCap option of checkPage');
  });

  it('completes the walk of that page with a stop cap raised for the screen', async () => {
    const output = await makeKeyboardWalkProvider().run(contextWith(await makeScriptedPage(longPage()), { [SCREEN.id]: { tabCap: 300 } }));

    expect(gapsOf(output)).toEqual([]);
    expect(Array.isArray(output) ? undefined : output.walk?.complete).toBe(true);
  });

  it('reads the setting of this screen only', async () => {
    const output = await makeKeyboardWalkProvider().run(contextWith(await makeScriptedPage(longPage()), { other: { tabCap: 300 } }));

    expect(cutShort(output)).toHaveLength(1);
  });

  it('cuts the walk short at the time cap, names the time setting, and completes with the time cap raised for the screen', async () => {
    const spec = (clock: ReturnType<typeof makeClock>): ScriptedPageSpec => ({
      ...namedButtonPage([...Array.from({ length: 50 }, (_, i) => `#stop-${i}`), BODY_PATH]),
      bodyAt: 50,
      onTab: () => clock.advance(60),
    });

    const short = makeClock();
    const cut = await makeKeyboardWalkProvider({ wallClockMs: 1_000, now: short.now }).run(makeContext(await makeScriptedPage(spec(short))));
    const reasons = cutShort(cut);
    expect(reasons[0]).toContain('ran out of its time budget of 1000 ms');
    expect(reasons[0]).toContain(`keyboardWalk.perSurface.${SCREEN.id}.wallClockMs in usabl.config.json`);
    expect(reasons[0]).toContain('the wallClockMs option of checkPage');

    const long = makeClock();
    const done = await makeKeyboardWalkProvider({ wallClockMs: 1_000, now: long.now }).run(
      contextWith(await makeScriptedPage(spec(long)), { [SCREEN.id]: { wallClockMs: 10_000 } }),
    );
    expect(gapsOf(done)).toEqual([]);
  });
});

// Product call 2, choice (a): a region the walk cannot read into is a not-covered gap, unless the
// team lists that region for that screen in the guarded config. A listed region is a disclosed
// limit, never a checked part of the screen.
describe('regions the team lists for a screen', () => {
  const FRAME = { kind: 'frame', origin: 'https://chat.example.com' } as const;
  const HOST = { kind: 'shadow-host', tag: 'chat-widget' } as const;

  async function regionPage(name: UnreadRegionName | null): Promise<Page> {
    const page = await makeScriptedPage({
      ...namedButtonPage(['#first', '#host', '#host', '#after', BODY_PATH]),
      unreadable: [null, 'frame-unreadable', 'frame-unreadable', null, null],
      bodyAt: 4,
    });
    page.activeUnreadRegion = async () => ((await page.activeFocusUnreadable()) === null ? null : name);
    return page;
  }

  function listing(regions: UnreadableRegionListing[]): ProviderContext['config'] {
    return { ...testConfig(), keyboardWalk: { perSurface: { [SCREEN.id]: { unreadableRegions: regions } } } };
  }

  async function walkWith(name: UnreadRegionName | null, regions: UnreadableRegionListing[] | null): Promise<ProviderOutput> {
    const page = await regionPage(name);
    const config = regions === null ? testConfig() : listing(regions);
    const output = await makeKeyboardWalkProvider({ tabCap: 10 }).run({ page, screen: SCREEN, config });
    return Array.isArray(output) ? { drafts: output } : output;
  }

  it('gives an unlisted region a gap that names it and says how to list it', async () => {
    const output = await walkWith(FRAME, null);

    const regions = unreadRegions(output);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toContain('a frame from https://chat.example.com');
    expect(regions[0]).toContain(`keyboardWalk.perSurface.${SCREEN.id}.unreadableRegions`);
    expect(regions[0]).toContain('{"frameOrigin": "https://chat.example.com"}');
    expect(output.notes ?? []).toEqual([]);
  });

  it('reads a listed frame as a disclosed limit, never a gap and never checked', async () => {
    const output = await walkWith(FRAME, [{ frameOrigin: 'https://chat.example.com' }]);

    expect(gapsOf(output)).toEqual([]);
    expect(output.notes).toEqual([
      {
        ref: 'provider:keyboard-walk/unread-region',
        reason: expect.stringContaining('a frame from https://chat.example.com'),
      },
    ]);
    expect(output.notes?.[0]?.reason).toContain('was not checked');
    expect(output.notes?.[0]?.reason).toContain('lists it as a known limit');
  });

  it('reads a listed closed shadow root by the tag of its host', async () => {
    const output = await walkWith(HOST, [{ shadowHost: 'chat-widget' }]);

    expect(gapsOf(output)).toEqual([]);
    expect(output.notes?.map((note) => note.reason)).toEqual([expect.stringContaining('a closed shadow root in a chat-widget element')]);
  });

  it('keeps a region a gap when the listing names another region, and reports the listing that matched nothing', async () => {
    const output = await walkWith(FRAME, [{ frameOrigin: 'https://other.example.com' }, { shadowHost: 'chat-widget' }]);

    expect(unreadRegions(output)).toHaveLength(1);
    const stale = (output.notes ?? []).map((note) => note.reason);
    expect(stale).toHaveLength(2);
    expect(stale[0]).toContain('{"frameOrigin": "https://other.example.com"}');
    expect(stale[0]).toContain('matched no region the keyboard walk met');
    expect(stale[1]).toContain('{"shadowHost": "chat-widget"}');
    // A stale listing is not a known limit: nothing went unchecked because of it.
    expect((output.notes ?? []).map((note) => note.ref)).toEqual([
      'provider:keyboard-walk/stale-region-listing',
      'provider:keyboard-walk/stale-region-listing',
    ]);
  });

  it('never matches a frame with no address it can name, nor focus too deep to name', async () => {
    for (const name of [{ kind: 'frame', origin: null } as const, { kind: 'unnamed' } as const, null]) {
      const output = await walkWith(name, [{ frameOrigin: 'https://chat.example.com' }]);
      expect(unreadRegions(output)).toHaveLength(1);
    }
  });

  it('reports no stale listing from a walk that was cut short, since it did not see the whole page', async () => {
    const page = await makeScriptedPage(namedButtonPage(['#a', '#b', '#c', '#d']));
    const output = await makeKeyboardWalkProvider({ tabCap: 2 }).run({ page, screen: SCREEN, config: listing([{ shadowHost: 'chat-widget' }]) });

    expect(cutShort(output)).toHaveLength(1);
    expect(Array.isArray(output) ? [] : (output.notes ?? [])).toEqual([]);
  });

  it('scrubs the page-derived name in the gap', async () => {
    const output = await walkWith({ kind: 'shadow-host', tag: 'x-widget token=SECRETPOISON' }, null);

    expect(unreadRegions(output)[0]).not.toContain('SECRETPOISON');
  });
});

// checkPage collects no transcript of its own, so the walk hands back the stops it reached, for the
// blank-page check only.
describe('the walk record the keyboard walk returns', () => {
  function walkOf(output: Draft[] | ProviderOutput): WalkRecord | undefined {
    return Array.isArray(output) ? undefined : output.walk;
  }

  it('records each stop it reached, the body stop at the end, and that the walk was complete', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({ ...namedButtonPage(['#a', '#b', BODY_PATH]), bodyAt: 2 });

    const output = await provider.run(makeContext(page));

    expect(draftsOf(output)).toEqual([]);
    expect(walkOf(output)?.complete).toBe(true);
    expect(walkOf(output)?.stops.map((stop) => [stop.index, stop.elementPath, stop.onBody])).toEqual([
      [0, '#a', undefined],
      [1, '#b', undefined],
      [2, BODY_PATH, true],
    ]);
  });

  it('records one stop on the body for a page with nothing to Tab to', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(unnamedLinkPage(['#app']));
    page.activeElementIs = async (selector) => selector === 'body';

    const output = await provider.run(makeContext(page));

    expect(draftsOf(output)).toEqual([]);
    expect(walkOf(output)).toEqual({
      stops: [expect.objectContaining({ index: 0, elementPath: '#app', onBody: true })],
      complete: true,
    });
  });

  it('says the walk was not complete when it was cut short', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 2 });
    const page = await makeScriptedPage(unnamedLinkPage(['#a', '#b', '#c']));

    const output = await provider.run(makeContext(page));

    expect(cutShort(output)).toHaveLength(1);
    expect(walkOf(output)?.complete).toBe(false);
    expect(walkOf(output)?.stops.map((stop) => stop.elementPath)).toEqual(['#a', '#b']);
  });

  it('says the walk was not complete when one more Tab after the body did not confirm the end', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage({ ...namedButtonPage([BODY_PATH]), bodyAt: 0, afterBody: '#second' });

    const output = await provider.run(makeContext(page));

    expect(draftsOf(output)).toEqual([]);
    expect(cutShort(output)).toHaveLength(1);
    expect(walkOf(output)?.complete).toBe(false);
  });
});

// checkPage drops these gaps, with the drafts, when the page left its screen during the checks, so
// the test is that it names exactly the walk's own gaps for this screen and nothing else.
describe('isWalkReachGap', () => {
  it('names the cut short gap and the unread region gap of this screen', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 3 });
    const page = await makeScriptedPage({
      ...namedButtonPage(['#first', '#frame', '#after', '#more', BODY_PATH]),
      unreadable: [null, 'frame-unreadable', null, null, null],
      bodyAt: 4,
    });

    const gaps = gapsOf(await provider.run(makeContext(page)));

    expect(gaps).toHaveLength(2);
    expect(gaps.map((gap) => isWalkReachGap(gap, SCREEN))).toEqual([true, true]);
    // The same gaps for another screen, and another gap on this screen, are not this walk's.
    const other = { id: 'orders', url: 'http://127.0.0.1:5173/orders' };
    expect(gaps.map((gap) => isWalkReachGap(gap, other))).toEqual([false, false]);
    expect(isWalkReachGap({ ref: SCREEN.url, state: 'not-covered', reason: 'scan cleanup failed: closed' }, SCREEN)).toBe(false);
    expect(isWalkReachGap({ ref: 'keyboard-walk', state: 'not-covered', reason: 'the walk threw' }, SCREEN)).toBe(false);
  });
});
