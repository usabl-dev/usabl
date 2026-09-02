import { describe, expect, it } from 'vitest';
import type { AxNode, Page, ProviderContext, Step } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeKeyboardWalkProvider } from '../../src/providers/keyboard-walk/index.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { draftsOf, testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

interface ScriptedPageSpec {
  activePaths: string[];
  activeNodes: Array<AxNode | null>;
  announcements: string[][];
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
    // The repeated path ends the walk on a completed focus cycle, so this case reads only the
    // detection behavior and never the separate disclosure a cut-short walk owes the operator.
    const provider = makeKeyboardWalkProvider({ tabCap: 5 });
    const page = await makeScriptedPage({
      activePaths: ['#mystery-focus', '#mystery-focus'],
      activeNodes: [null, null],
      announcements: [[], []],
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
      evidence: {},
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
      activePaths: ['#empty-link', '#empty-link'],
      activeNodes: [
        { name: null, role: 'link', states: {} },
        { name: null, role: 'link', states: {} },
      ],
      announcements: [[], []],
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
    const first = draftsOf(await provider.run(makeContext(await makeScriptedPage(unnamedLinkPage(['#a', '#b', '#b'])))));

    clock.advance(30_000);
    const second = draftsOf(await provider.run(makeContext(await makeScriptedPage(unnamedLinkPage(['#a', '#b', '#b'])))));

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

  it('emits no truncation draft when the focus cycle completes inside the budget', async () => {
    const clock = makeClock();
    const provider = makeKeyboardWalkProvider({ tabCap: 10, wallClockMs: 1_000, now: clock.now });
    const page = await makeScriptedPage({
      ...unnamedLinkPage(['#only-link', '#only-link']),
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
});
