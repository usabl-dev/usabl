import { describe, expect, it } from 'vitest';
import type { AxNode, FocusUnreadable, Page, ProviderContext, Step } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeKeyboardWalkProvider } from '../../src/providers/keyboard-walk/index.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { draftsOf, testConfig } from '../helpers.js';

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
  // The paths of the open modal dialogs that hold the focused element, at each stop.
  modals?: string[][];
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

function currentIndex(cursor: number): number {
  return cursor < 0 ? 0 : cursor;
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
    activePath: async () => readAt(spec.activePaths, currentIndex(cursor), ''),
    activeNode: async () => readAt(spec.activeNodes, currentIndex(cursor), null),
    drainAnnouncements: async () => readAt(spec.announcements, currentIndex(cursor), []),
    activeFocusUnreadable: async () => readAt(spec.unreadable ?? [], currentIndex(cursor), null),
    activeModalDialogs: async () => readAt(spec.modals ?? [], currentIndex(cursor), []),
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

    const drafts = draftsOf(await provider.run(makeContext(page)));

    const walked = drafts.filter((d) => d.rule === 'keyboard-walk-unnamed-interactive');
    expect(walked.length).toBeGreaterThan(0);
    expect(walked.length).toBeLessThan(paths.length);

    const truncated = drafts.filter((d) => d.rule === 'keyboard-walk-truncated');
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toMatchObject({
      layer: 'walk',
      evidenceClass: 'deterministic',
      confidence: 'unverified',
      screenId: SCREEN.id,
    });
    expect(truncated[0]?.why).toMatch(/\d+ tab stop/);
  });

  it('discloses truncation when the walk stops at the tab cap', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 2 });
    const page = await makeScriptedPage(unnamedLinkPage(['#a', '#b', '#c', '#d']));

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(drafts.filter((d) => d.rule === 'keyboard-walk-unnamed-interactive')).toHaveLength(2);
    const truncated = drafts.filter((d) => d.rule === 'keyboard-walk-truncated');
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toMatchObject({
      evidenceClass: 'deterministic',
      confidence: 'unverified',
    });
    expect(truncated[0]?.why).toMatch(/\d+ tab stop/);
  });

  it('emits no truncation draft when the walk reaches the end of the page inside the budget', async () => {
    const clock = makeClock();
    const provider = makeKeyboardWalkProvider({ tabCap: 10, wallClockMs: 1_000, now: clock.now });
    const page = await makeScriptedPage({
      ...unnamedLinksThenBody(['#only-link']),
      onTab: () => clock.advance(10),
    });

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(rules(drafts)).toEqual(['keyboard-walk-unnamed-interactive']);
  });

  it('emits no truncation draft when the walk ends on the document body', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(unnamedLinkPage(['html > body:nth-child(2)']));
    page.activeElementIs = async (selector) => selector === 'body';

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(drafts).toEqual([]);
  });

  // A closed shadow root or a frame from another origin gives every control inside it the path of
  // the host or the frame. Read as paths alone, the second control is a return to the first and
  // the walk ends as complete, with nothing said about the controls after it.
  for (const [reason, where, words] of [
    ['closed-shadow-root', 'into a closed shadow root', 'closed shadow root'],
    ['frame-unreadable', 'into a frame from another origin', 'frame from another origin'],
    ['focus-too-deep', 'deeper than the read follows', 'more shadow roots and frames'],
  ] as const) {
    it(`discloses truncation instead of a cycle when focus moves ${where}`, async () => {
      const provider = makeKeyboardWalkProvider({ tabCap: 10 });
      const page = await makeScriptedPage({
        ...unnamedLinkPage(['#first', '#host', '#host', '#after']),
        unreadable: [null, reason, reason, null],
      });

      const drafts = draftsOf(await provider.run(makeContext(page)));

      expect(rules(drafts)).toEqual(['keyboard-walk-unnamed-interactive', 'keyboard-walk-truncated']);
      expect(drafts[0]?.elementPath).toBe('#first');
      expect(drafts[1]).toMatchObject({ evidenceClass: 'deterministic', confidence: 'unverified', elementPath: '' });
      expect(drafts[1]?.why).toContain(words);
      expect(drafts[1]?.why).toContain('After 1 tab stop(s)');
      expect(drafts[1]?.fix).toContain('by hand');
    });
  }

  // A focus trap: Tab from the second control goes back to the first, so focus never reaches the
  // body and the controls after the trap are never walked. Read as a completed cycle, the walk
  // reported nothing and the screen read as covered.
  it('reports a keyboard trap and a truncation gap when focus cycles without reaching the body', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(namedButtonPage(['#before', '#one', '#two', '#one', '#outside']));

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(rules(drafts)).toEqual(['keyboard-walk-trap', 'keyboard-walk-truncated']);
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
    expect(drafts[1]).toMatchObject({ evidenceClass: 'deterministic', confidence: 'unverified', elementPath: '' });
    expect(drafts[1]?.why).toBe(
      'After 3 tab stop(s), focus went back to a control the keyboard walk had already reached, without reaching the end of the page, so the controls after the trap were never walked.',
    );
    expect(JSON.stringify(drafts)).not.toContain('Page text');
  });

  it('reports a control that keeps focus on every Tab as a trap of one stop', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(namedButtonPage(['#stuck', '#stuck', '#stuck']));

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(rules(drafts)).toEqual(['keyboard-walk-trap', 'keyboard-walk-truncated']);
    expect(drafts[0]?.elementPath).toBe('#stuck');
    expect(drafts[0]?.evidence.extra?.['cycle']).toEqual(['#stuck']);
    expect(drafts[0]?.why).toContain('1 control(s)');
  });

  // An open modal dialog keeps focus inside itself on purpose. That is the expected behavior, not
  // a barrier, but the rest of the page behind the dialog was still never walked.
  it('ends with a gap and no trap when the cycle stays inside an open modal dialog', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(namedButtonPage(['#one', '#two', '#one'], [['#dialog'], ['#dialog'], ['#dialog']]));

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(rules(drafts)).toEqual(['keyboard-walk-truncated']);
    expect(drafts[0]).toMatchObject({ evidenceClass: 'deterministic', confidence: 'unverified', elementPath: '' });
    expect(drafts[0]?.why).toBe(
      'After 2 tab stop(s), focus went back to a control it had already reached, and every control in that cycle is inside one open modal dialog. Focus stayed inside the dialog, and the rest of the page was not walked.',
    );
    expect(drafts[0]?.fix).toContain('dialog');
  });

  it('reads a cycle inside a modal dialog nested in another as staying inside the outer one', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(
      namedButtonPage(['#one', '#two', '#one'], [['#outer', '#outer >> #inner'], ['#outer'], ['#outer', '#outer >> #inner']]),
    );

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(rules(drafts)).toEqual(['keyboard-walk-truncated']);
    expect(drafts[0]?.why).toContain('modal dialog');
  });

  // Stops walked before the cycle began sit outside the dialog. Only the cycle is judged, so this
  // is still a cycle inside one modal dialog. A rule that judged every walked stop would call it a
  // keyboard trap.
  it('judges only the stops of the cycle, not the stops walked before it', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(namedButtonPage(['#before', '#one', '#two', '#one'], [[], ['#d'], ['#d'], ['#d']]));

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(rules(drafts)).toEqual(['keyboard-walk-truncated']);
    expect(drafts[0]?.why).toContain('After 3 tab stop(s)');
    expect(drafts[0]?.why).toContain('inside one open modal dialog');
  });

  it('reports a trap when the modal dialog does not hold every stop of the cycle', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    // The first stop is before the cycle and outside the dialog. The cycle itself leaves it.
    const page = await makeScriptedPage(namedButtonPage(['#before', '#one', '#two', '#one'], [[], ['#dialog'], [], ['#dialog']]));

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(rules(drafts)).toEqual(['keyboard-walk-trap', 'keyboard-walk-truncated']);
    expect(drafts[0]?.evidence.extra?.['cycle']).toEqual(['#one', '#two']);
  });

  it('reads a cycle in two different modal dialogs as a trap', async () => {
    const provider = makeKeyboardWalkProvider({ tabCap: 10 });
    const page = await makeScriptedPage(namedButtonPage(['#one', '#two', '#one'], [['#first-dialog'], ['#second-dialog'], ['#first-dialog']]));

    const drafts = draftsOf(await provider.run(makeContext(page)));

    expect(rules(drafts)).toEqual(['keyboard-walk-trap', 'keyboard-walk-truncated']);
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
