import { describe, expect, it, vi } from 'vitest';
import type { AxNode, AxTreeNode, Draft, ElementRef, Page, Requirement } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { designCheckProvider } from '../../src/intake/structure-providers.js';
import { draftsOf, gapsOf, testConfig } from '../helpers.js';

const SCREEN = { id: 'users', url: 'http://127.0.0.1/users' };

// The whole accessibility tree a browser would build from these nodes.
function treeOf(nodes: readonly AxNode[]): AxTreeNode[] {
  return nodes.map((node, index) => ({
    nodeId: index + 1,
    parentId: null,
    role: node.role,
    name: node.name,
    ignored: false,
    states: {},
    busy: false,
    controls: [],
  }));
}

function pageWith(nodes: Record<string, AxNode>, overrides: Partial<Page> = {}): Page {
  const refs: ElementRef[] = Object.keys(nodes).map((selector) => ({ selector }));
  return makeFakePage({
    queryAll: async () => refs,
    axAt: async (s: string) => nodes[s] ?? null,
    countEverywhere: async () => refs.length,
    fullAxTree: async () => ({ kind: 'tree', documentNodeId: null, nodes: treeOf(Object.values(nodes)) }),
    ...overrides,
  });
}

function req(assertion: Requirement['assertion']): Requirement {
  return { id: `r-${assertion.type}`, kind: assertion.type, surface: 'users', description: 'd', assertion, approved: true };
}

async function run(r: Requirement, page: Page): Promise<Draft[]> {
  const provider = designCheckProvider(r);
  if (provider === null) throw new Error('no provider');
  const output = await provider.run({ page, screen: SCREEN, config: testConfig() });
  expect(gapsOf(output)).toEqual([]);
  return draftsOf(output);
}

const button = (name: string | null): AxNode => ({ name, role: 'button', states: {} });

describe('designCheckProvider', () => {
  it('builds a provider for each design kind and none for the others', () => {
    expect(designCheckProvider(req({ type: 'name', target: { role: 'button', name: 'R' } }))?.layer).toBe('intake-name');
    expect(designCheckProvider(req({ type: 'heading', name: 'H', level: 1 }))?.layer).toBe('intake-heading');
    expect(designCheckProvider(req({ type: 'landmark', role: 'main' }))?.layer).toBe('intake-landmark');
    expect(designCheckProvider(req({ type: 'focus-order', sequence: ['A', 'B'] }))?.layer).toBe('intake-focus-order');
    expect(
      designCheckProvider(req({ type: 'target-size', target: { role: 'button', name: 'R' }, minCssPx: 24 }))?.layer,
    ).toBe('intake-target-size');
    expect(designCheckProvider(req({ type: 'content', selector: 'h1', expectedText: 'x' }))).toBeNull();
    expect(designCheckProvider(req({ type: 'doc', artifact: 'alt-text-manifest' }))).toBeNull();
  });

  it('names the provider by the requirement id and asks only for a live page', () => {
    const provider = designCheckProvider(req({ type: 'name', target: { role: 'button', name: 'R' } }));
    expect(provider?.id).toBe('intake:r-name');
    expect(provider?.capabilities).toEqual(['live']);
  });

  it('reports nothing on another surface and does not touch the page', async () => {
    const queryAll = vi.fn(async () => [] as ElementRef[]);
    const provider = designCheckProvider(req({ type: 'landmark', role: 'main' }));
    const output = await provider!.run({ page: makeFakePage({ queryAll }), screen: { id: 'other', url: 'x' }, config: testConfig() });
    expect(draftsOf(output)).toEqual([]);
    expect(queryAll).not.toHaveBeenCalled();
  });

  it('emits drafts only, each a deterministic intake draft for its requirement', async () => {
    const drafts = await run(req({ type: 'name', target: { role: 'button', name: 'Refresh' } }), pageWith({}));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'intake:r-name',
      layer: 'intake-name',
      evidenceClass: 'deterministic',
      screenId: 'users',
      confidence: 'fail',
    });
    expect(Object.keys(drafts[0] ?? {})).not.toContain('verdict');
    expect(Object.keys(drafts[0] ?? {})).not.toContain('status');
  });
});

describe('name requirement', () => {
  const r = req({ type: 'name', target: { role: 'button', name: 'Refresh' } });

  it('passes when one element has the role and name', async () => {
    expect(await run(r, pageWith({ '#r': button('Refresh') }))).toEqual([]);
  });

  it('fails with a plain message when no element has them', async () => {
    const drafts = await run(r, pageWith({ '#r': button(null) }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.whatUserExperiences).toBe('There is no button named "Refresh" on this screen.');
    expect(drafts[0]?.confidence).toBe('fail');
  });

  it('is unconfirmed, never a pass, when two elements have the name', async () => {
    const drafts = await run(r, pageWith({ '#a': button('Refresh'), '#b': button('Refresh') }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toContain('2 buttons on this screen are named "Refresh"');
  });

  it('is unconfirmed, never a fail, when candidates sit where usabl cannot read them', async () => {
    const page = pageWith({ '#d': button('Delete') }, { countEverywhere: async () => 2 });
    const drafts = await run(r, page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toContain('shadow root or a frame');
  });

  it('is unconfirmed, never a pass, when the accessibility tree has a second element the document search cannot read', async () => {
    // A second Refresh button in a closed shadow root: the tree has it, the document query does not.
    const page = pageWith(
      { '#r': button('Refresh') },
      { fullAxTree: async () => ({ kind: 'tree', documentNodeId: null, nodes: treeOf([button('Refresh'), button('Refresh')]) }) },
    );
    const drafts = await run(r, page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toContain('2 buttons on this screen are named "Refresh"');
  });

  it('is unconfirmed, never a fail, when the tree has the element and the document search does not', async () => {
    const page = pageWith(
      {},
      { fullAxTree: async () => ({ kind: 'tree', documentNodeId: null, nodes: treeOf([button('Refresh')]) }) },
    );
    const drafts = await run(r, page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toBe(
      'The page\'s accessibility tree has 1 button named "Refresh", and usabl found 0 it can read in the page document, so it cannot tell which element the design means, and it does not guess.',
    );
  });

  it('is unconfirmed when the accessibility tree cannot be read', async () => {
    const page = pageWith({ '#r': button('Refresh') }, { fullAxTree: async () => ({ kind: 'over-budget', limit: 'time' }) });
    const drafts = await run(r, page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
  });
});

describe('heading requirement', () => {
  const r = req({ type: 'heading', name: 'Users', level: 1 });
  const heading = (level: unknown): AxNode => ({ name: 'Users', role: 'heading', states: { level } });

  it('passes at the right level', async () => {
    expect(await run(r, pageWith({ '#h': heading(1) }))).toEqual([]);
  });

  it('fails at the wrong level and says both levels', async () => {
    const drafts = await run(r, pageWith({ '#h': heading(2) }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.whatUserExperiences).toBe('The heading "Users" is level 2. The design says level 1.');
    expect(drafts[0]?.elementPath).toBe('#h');
    expect(drafts[0]?.evidence.extra).toEqual({ expectedLevel: 1, actualLevel: 2 });
  });

  it('fails when no heading has the name', async () => {
    const drafts = await run(r, pageWith({ '#p': { name: 'Users', role: 'paragraph', states: {} } }));
    expect(drafts[0]?.whatUserExperiences).toBe('There is no heading named "Users" on this screen.');
    expect(drafts[0]?.confidence).toBe('fail');
  });

  it('is unconfirmed when the level cannot be read', async () => {
    const drafts = await run(r, pageWith({ '#h': heading(undefined) }));
    expect(drafts[0]?.confidence).toBe('unverified');
  });

  it('is unconfirmed when two headings have the name, whatever their levels', async () => {
    const drafts = await run(r, pageWith({ '#a': heading(1), '#b': heading(2) }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
  });
});

describe('landmark requirement', () => {
  const nav: AxNode = { name: 'Primary', role: 'navigation', states: {} };

  it('passes when the landmark exists and checks its name when one is given', async () => {
    const page = pageWith({ '#n': nav });
    expect(await run(req({ type: 'landmark', role: 'navigation' }), page)).toEqual([]);
    expect(await run(req({ type: 'landmark', role: 'navigation', name: 'Primary' }), page)).toEqual([]);
    const wrongName = await run(req({ type: 'landmark', role: 'navigation', name: 'Footer links' }), page);
    expect(wrongName[0]?.whatUserExperiences).toBe('There is no navigation area named "Footer links" on this screen.');
    const missing = await run(req({ type: 'landmark', role: 'main' }), page);
    expect(missing[0]?.whatUserExperiences).toBe('There is no main content area on this screen.');
  });

  it('passes an unnamed landmark requirement when the role appears more than once', async () => {
    const page = pageWith({ '#a': nav, '#b': { ...nav, name: 'Secondary' } });
    expect(await run(req({ type: 'landmark', role: 'navigation' }), page)).toEqual([]);
  });

  it('counts a region or a form only when it has an accessible name', async () => {
    const unnamed = pageWith({
      '#r': { name: null, role: 'region', states: {} },
      '#f': { name: '  ', role: 'form', states: {} },
    });
    expect(await run(req({ type: 'landmark', role: 'region' }), unnamed)).toHaveLength(1);
    expect(await run(req({ type: 'landmark', role: 'form' }), unnamed)).toHaveLength(1);
    const named = pageWith({ '#r': { name: 'Usage', role: 'region', states: {} } });
    expect(await run(req({ type: 'landmark', role: 'region' }), named)).toEqual([]);
  });

  it('is unconfirmed when the landmark is missing and candidates sit out of reach', async () => {
    const page = pageWith({}, { countEverywhere: async () => 1 });
    const drafts = await run(req({ type: 'landmark', role: 'main' }), page);
    expect(drafts[0]?.confidence).toBe('unverified');
  });

  it('is unconfirmed, never a fail, when only the accessibility tree has the landmark', async () => {
    const main: AxNode = { name: null, role: 'main', states: {} };
    const page = pageWith({}, { fullAxTree: async () => ({ kind: 'tree', documentNodeId: null, nodes: treeOf([main]) }) });
    const drafts = await run(req({ type: 'landmark', role: 'main' }), page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
  });
});

// A page whose Tab order visits the given names, then reaches the body, then goes back to the first
// name, as Chromium does.
function tabbingPage(names: Array<string | null>, overrides: Partial<Page> = {}): Page {
  let cursor = -1;
  const onBody = (): boolean => cursor < 0 || cursor === names.length;
  return makeFakePage({
    focusBody: async () => {
      cursor = -1;
    },
    tab: async () => {
      cursor = (cursor + 1) % (names.length + 1);
    },
    activeElementIs: async (sel: string) => sel === 'body' && onBody(),
    activeNode: async () => {
      if (onBody()) return null;
      const name = names[cursor];
      return name === null ? null : { name: name ?? null, role: 'button', states: {} };
    },
    activePath: async () => (onBody() ? 'body' : `#stop-${cursor}`),
    ...overrides,
  });
}

// One place focus can be after a Tab: a control with a path, a node key, and a name, or the body.
type Stop = { path: string; key: string | null; name: string } | 'body';

// A page where each Tab moves focus to the next entry of a script, whatever the page holds. It
// models pages whose scripts move focus: a handler that blurs a control, one that stops Tab, and a
// list that renders again. After the script runs out, focus stays on the body.
function scriptedPage(script: readonly Stop[]): Page {
  let cursor = -1;
  const at = (): Stop => (cursor < 0 ? 'body' : (script[cursor] ?? 'body'));
  return makeFakePage({
    focusBody: async () => {
      cursor = -1;
    },
    tab: async () => {
      cursor += 1;
    },
    activeElementIs: async (sel: string) => sel === 'body' && at() === 'body',
    activeNode: async () => {
      const stop = at();
      return stop === 'body' ? null : { name: stop.name, role: 'button', states: {} };
    },
    activePath: async () => {
      const stop = at();
      return stop === 'body' ? 'body' : stop.path;
    },
    activeElementKey: async () => {
      const stop = at();
      return stop === 'body' ? null : stop.key;
    },
  });
}

const stop = (path: string, name: string, key: string | null = null): Stop => ({ path, key, name });

// Focus never returns to the body: it cycles through the same stops, like a focus trap.
function cyclingPage(names: string[]): Page {
  let cursor = -1;
  const at = (): number => cursor % names.length;
  return makeFakePage({
    focusBody: async () => {
      cursor = -1;
    },
    tab: async () => {
      cursor += 1;
    },
    activeElementIs: async () => false,
    activeNode: async () => (cursor >= 0 ? { name: names[at()] ?? null, role: 'button', states: {} } : null),
    activePath: async () => `#trap-${at()}`,
  });
}

describe('focus order requirement', () => {
  const r = req({ type: 'focus-order', sequence: ['Create user', 'Refresh', 'Actions for alice'] });

  it('passes when focus reaches the names in order, with other stops between', async () => {
    const page = tabbingPage(['Skip to content', 'Create user', 'Refresh', 'Filter', 'Actions for alice']);
    expect(await run(r, page)).toEqual([]);
  });

  it('fails and says which name focus never reached', async () => {
    const drafts = await run(r, tabbingPage(['Actions for alice', 'Create user', '']));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('fail');
    expect(drafts[0]?.whatUserExperiences).toBe(
      'Focus never reached "Refresh". The design puts it after "Create user". Focus went: Actions for alice, Create user, (no name).',
    );
  });

  it('fails and says which names came in the wrong order', async () => {
    const drafts = await run(r, tabbingPage(['Refresh', 'Create user', 'Actions for alice']));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.whatUserExperiences).toBe(
      'Focus reached "Refresh" before "Create user". The design puts "Create user" first. Focus went: Refresh, Create user, Actions for alice.',
    );
  });

  it('keeps a constant element path, so the finding has one identity from run to run', async () => {
    const drafts = await run(r, tabbingPage(['Refresh', 'Create user']));
    expect(drafts[0]?.elementPath).toBe('body');
    expect(drafts[0]?.evidence.extra).toMatchObject({ expected: r.assertion.type === 'focus-order' ? r.assertion.sequence : [] });
  });

  it('is unconfirmed when a listed name is on more than one focus stop', async () => {
    const form = req({ type: 'focus-order', sequence: ['Name', 'Email', 'Submit'] });
    const drafts = await run(form, tabbingPage(['Name', 'Submit', 'Email', 'Submit']));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toContain('"Submit" is on 2 focus stops');
  });

  it('is unconfirmed, never a pass or a fail, when focus cycles without reaching the end of the page', async () => {
    // A focus trap, or a part of the page that rendered again: the walk never reached the end, so
    // the rest of the order is unknown.
    for (const sequence of [['Reject', 'Accept'], ['Accept', 'Reject']]) {
      const drafts = await run(req({ type: 'focus-order', sequence }), cyclingPage(['Accept', 'Reject']));
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.confidence).toBe('unverified');
      expect(drafts[0]?.why).toContain('focus went back to a control the walk had already reached');
    }
  });

  it('passes when one more Tab after the body goes back to a control it walked', async () => {
    const page = scriptedPage([
      stop('#s0', 'Create user', 'k0'),
      stop('#s1', 'Refresh', 'k1'),
      stop('#s2', 'Actions for alice', 'k2'),
      'body',
      stop('#s0', 'Create user', 'k0'),
    ]);
    expect(await run(r, page)).toEqual([]);
  });

  it('is unconfirmed, never a fail, when a control blurs itself and the next Tab lands on a new control', async () => {
    // "Refresh" blurs itself when it gets focus, so focus falls to the body in the middle of the page.
    const page = scriptedPage([stop('#s0', 'Create user', 'k0'), 'body', stop('#s2', 'Actions for alice', 'k2')]);
    const drafts = await run(r, page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toContain('one more Tab did not go back to a control the walk had already reached');
    expect(drafts[0]?.evidence.extra).toMatchObject({ heard: ['Create user'] });
  });

  it('is unconfirmed, never a fail, when a script stops Tab and focus stays on the body', async () => {
    const page = scriptedPage([stop('#s0', 'Create user', 'k0'), 'body', 'body']);
    const drafts = await run(r, page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
  });

  it('keeps walking when a list renders again and a new element takes a walked path', async () => {
    // The browser gives each element its own key, so a new element at a walked path is a new stop.
    const page = scriptedPage([
      stop('#row-0', 'Create user', 'k0'),
      stop('#row-1', 'Refresh', 'k1'),
      stop('#row-0', 'Actions for alice', 'k2'),
      'body',
      stop('#row-0', 'Actions for alice', 'k2'),
    ]);
    expect(await run(r, page)).toEqual([]);
  });

  it('is unconfirmed, never a fail, when a walked path comes back and the browser gives no key', async () => {
    const page = scriptedPage([
      stop('#row-0', 'Create user'),
      stop('#row-1', 'Refresh'),
      stop('#row-0', 'Actions for alice'),
      'body',
    ]);
    const drafts = await run(r, page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
  });

  it('puts focus back on the body after it confirms the end', async () => {
    const calls: string[] = [];
    const base = tabbingPage(['Create user', 'Refresh', 'Actions for alice']);
    const page: Page = {
      ...base,
      focusBody: async () => {
        calls.push('focusBody');
        await base.focusBody();
      },
      tab: async () => {
        calls.push('tab');
        await base.tab();
      },
    };
    expect(await run(r, page)).toEqual([]);
    // Four Tabs reach the three controls and the body, and one more confirms the end.
    expect(calls).toEqual(['focusBody', 'tab', 'tab', 'tab', 'tab', 'tab', 'focusBody']);
  });

  it('is unconfirmed when a focus stop cannot be read', async () => {
    const drafts = await run(r, tabbingPage(['Create user', null, 'Refresh', 'Actions for alice']));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
  });

  it('is unconfirmed when focus goes where usabl cannot read it', async () => {
    const page = tabbingPage(['Create user', 'Refresh'], {
      activeFocusUnreadable: async () => 'closed-shadow-root',
    });
    const drafts = await run(r, page);
    expect(drafts[0]?.confidence).toBe('unverified');
  });

  it('is unconfirmed when the walk runs out of stops, never a pass', async () => {
    let cursor = -1;
    const tab = vi.fn(async () => {
      cursor += 1;
    });
    const endless = makeFakePage({
      focusBody: async () => {
        cursor = -1;
      },
      tab,
      activeElementIs: async () => false,
      activeNode: async () => ({ name: cursor === 0 ? 'Create user' : `Item ${cursor}`, role: 'button', states: {} }),
      activePath: async () => `#item-${cursor}`,
    });
    const drafts = await run(req({ type: 'focus-order', sequence: ['Create user', 'Item 5'] }), endless);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(tab).toHaveBeenCalledTimes(200);
  });

  it('starts from the top of the page', async () => {
    const calls: string[] = [];
    const base = tabbingPage(['Create user', 'Refresh', 'Actions for alice']);
    const page: Page = {
      ...base,
      focusBody: async () => {
        calls.push('focusBody');
        await base.focusBody();
      },
      tab: async () => {
        calls.push('tab');
        await base.tab();
      },
    };
    await run(r, page);
    expect(calls[0]).toBe('focusBody');
  });

  it('needs the page as it loaded and does not say it changes the page', () => {
    const provider = designCheckProvider(r);
    expect(provider?.requiresPristinePage).toBe(true);
    expect(provider?.mutatesPageState).toBeUndefined();
  });
});

describe('target size requirement', () => {
  const r = req({ type: 'target-size', target: { role: 'button', name: 'Refresh' }, minCssPx: 24 });

  // One unclipped box unless the case says otherwise.
  function sized(box: { width: number; height: number; fragments?: number; clipped?: boolean } | null): Page {
    const read = box === null ? null : { fragments: 1, clipped: false, ...box };
    return pageWith({ '#r': button('Refresh') }, { boundingBox: async () => read });
  }

  it('is unconfirmed, never a pass, when the element is laid out in more than one box', async () => {
    // An inline link that wraps onto two lines: the union of its boxes is large, each box may not be.
    const drafts = await run(r, sized({ width: 120, height: 40, fragments: 2 }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toContain('laid out in 2 boxes');
  });

  it('is unconfirmed, never a pass, when an element above it clips it', async () => {
    const drafts = await run(r, sized({ width: 44, height: 44, clipped: true }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toContain('clips it');
  });

  it('passes at or above the minimum in both directions', async () => {
    expect(await run(r, sized({ width: 24, height: 32 }))).toEqual([]);
  });

  it('fails below the minimum and names the size', async () => {
    const drafts = await run(r, sized({ width: 16, height: 16 }));
    expect(drafts[0]?.whatUserExperiences).toBe('"Refresh" is 16 by 16 CSS pixels. The design asks for at least 24.');
    expect(drafts[0]?.elementPath).toBe('#r');
  });

  it('compares the measured size and never shows a failing size as the minimum', async () => {
    const drafts = await run(r, sized({ width: 23.96, height: 30 }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.evidence.extra).toMatchObject({ width: 23.96, height: 30 });
    expect(drafts[0]?.whatUserExperiences).toBe('"Refresh" is 23.9 by 30 CSS pixels. The design asks for at least 24.');
  });

  it('is unconfirmed, never a fail, when the element is missing, so the name check reports the absence', async () => {
    const drafts = await run(r, pageWith({}));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.whatUserExperiences).toBe(
      'Whether the button named "Refresh" is at least 24 CSS pixels is unknown: no button on this screen has that name.',
    );
  });

  it('is unconfirmed when two elements have the name', async () => {
    const page = pageWith({ '#a': button('Refresh'), '#b': button('Refresh') }, { boundingBox: async () => ({ width: 1, height: 1, fragments: 1, clipped: false }) });
    const drafts = await run(r, page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
  });

  it('is unconfirmed when the size cannot be read', async () => {
    const drafts = await run(r, sized(null));
    expect(drafts[0]?.confidence).toBe('unverified');
  });

  it('only reads the page and does not need it as it loaded', () => {
    const provider = designCheckProvider(r);
    expect(provider?.mutatesPageState).toBeUndefined();
    expect(provider?.requiresPristinePage).toBeUndefined();
  });
});
