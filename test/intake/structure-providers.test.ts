import { describe, expect, it, vi } from 'vitest';
import type { AxNode, AxTreeNode, BoxLimit, Draft, ElementRef, Page, Provider, Requirement } from '../../src/contracts/index.js';
import { DESIGN_AX_TREE_NODE_LIMIT } from '../../src/deps/ax-tree.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { designCheckProvider } from '../../src/intake/structure-providers.js';
import { runProviders } from '../../src/providers/index.js';
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
    designAxTree: async () => ({ kind: 'tree', nodes: treeOf(Object.values(nodes)) }),
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

  it('is unconfirmed, never a fail, when the accessibility tree answer could not be read', async () => {
    const page = pageWith({}, { designAxTree: async () => ({ kind: 'unreadable' }) });
    const drafts = await run(r, page);
    expect(drafts.map((d) => d.confidence)).toEqual(['unverified']);
    expect(drafts[0]?.why).toBe(
      'The browser gave an accessibility tree usabl could not read, so it cannot make sure that no other button is named "Refresh", and it does not guess.',
    );
    expect(drafts[0]?.whatUserExperiences).not.toContain('There is no button');
  });

  it('is unconfirmed, and names the hidden character, when the page name differs only by a no-break space', async () => {
    const drafts = await run(r, pageWith({ '#r': button('Refresh ') }));
    expect(drafts.map((d) => d.confidence)).toEqual(['unverified']);
    expect(drafts[0]?.whatUserExperiences).not.toContain('There is no button');
    expect(drafts[0]?.why).toBe(
      'A button on this screen is named "Refresh" followed by a no-break space, and the design names it "Refresh". The two names differ only in white space that cannot be seen, so usabl cannot tell whether this is the button the design means, and it does not guess.',
    );
    expect(drafts[0]?.elementPath).toBe('#r');
  });

  it('names a no-break space in the design name, and where it is', async () => {
    const save = req({ type: 'name', target: { role: 'button', name: 'Save draft' } });
    const drafts = await run(save, pageWith({ '#s': button('Save draft') }));
    expect(drafts.map((d) => d.confidence)).toEqual(['unverified']);
    expect(drafts[0]?.why).toContain('is named "Save draft", and the design names it "Save", a no-break space, then "draft".');
    expect(drafts[0]?.whatUserExperiences).toBe(
      'Whether the screen has the button the design names "Save", a no-break space, then "draft" is unknown.',
    );
  });

  it('counts every element whose name differs only in white space, and still does not guess', async () => {
    const drafts = await run(r, pageWith({ '#a': button('Refresh '), '#b': button('　Refresh') }));
    expect(drafts.map((d) => d.confidence)).toEqual(['unverified']);
    expect(drafts[0]?.why).toContain('2 buttons on this screen have names that differ from "Refresh" only in white space that cannot be seen');
    expect(drafts[0]?.elementPath).toBe('body');
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
      { designAxTree: async () => ({ kind: 'tree', nodes: treeOf([button('Refresh'), button('Refresh')]) }) },
    );
    const drafts = await run(r, page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toContain('2 buttons on this screen are named "Refresh"');
  });

  it('is unconfirmed, never a fail, when the tree has the element and the document search does not', async () => {
    const page = pageWith(
      {},
      { designAxTree: async () => ({ kind: 'tree', nodes: treeOf([button('Refresh')]) }) },
    );
    const drafts = await run(r, page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toBe(
      'The page\'s accessibility tree has 1 button named "Refresh", and usabl found 0 it can read in the page document, so it cannot tell which element the design means, and it does not guess.',
    );
  });

  it('is unconfirmed, and names the limit, when the accessibility tree has more nodes than usabl reads', async () => {
    const page = pageWith(
      { '#r': button('Refresh') },
      { designAxTree: async () => ({ kind: 'over-limit', limit: DESIGN_AX_TREE_NODE_LIMIT }) },
    );
    const drafts = await run(r, page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toBe(
      `The page's accessibility tree has more than ${DESIGN_AX_TREE_NODE_LIMIT} nodes, the most usabl reads for a design check, so it cannot make sure that no other button is named "Refresh", and it does not guess.`,
    );
    expect(drafts[0]?.evidence.extra).toMatchObject({ nodeLimit: DESIGN_AX_TREE_NODE_LIMIT });
    expect(drafts[0]?.fix).toContain(`usabl reads at most ${DESIGN_AX_TREE_NODE_LIMIT} accessibility tree nodes`);
  });
});

describe('the accessibility tree the design checks read', () => {
  const nameReq = (id: string, name: string): Requirement => ({ ...req({ type: 'name', target: { role: 'button', name } }), id });
  const providersOf = (requirements: Requirement[]): Provider[] =>
    requirements.map((r) => {
      const provider = designCheckProvider(r);
      if (provider === null) throw new Error('no provider');
      return provider;
    });

  it('is read once per page state, however many requirements check that screen', async () => {
    const designAxTree = vi.fn(async () => ({ kind: 'tree' as const, nodes: treeOf([button('Refresh'), button('Save')]) }));
    const page = pageWith({ '#r': button('Refresh'), '#s': button('Save') }, { designAxTree });
    const result = await runProviders(
      providersOf([nameReq('r-refresh', 'Refresh'), nameReq('r-save', 'Save'), req({ type: 'landmark', role: 'main' })]),
      { page, screen: SCREEN, config: testConfig() },
      ['live'],
    );
    expect(result.gaps).toEqual([]);
    expect(designAxTree).toHaveBeenCalledTimes(1);
  });

  it('is read again after the focus order walk, because the walk changes the page', async () => {
    const designAxTree = vi.fn(async () => ({ kind: 'tree' as const, nodes: treeOf([button('Refresh')]) }));
    const page = tabbingPage(['Refresh'], {
      queryAll: async () => [{ selector: '#r' }],
      axAt: async () => button('Refresh'),
      countEverywhere: async () => 1,
      designAxTree,
    });
    const result = await runProviders(
      providersOf([nameReq('r-before', 'Refresh'), req({ type: 'focus-order', sequence: ['Refresh'] }), nameReq('r-after', 'Refresh')]),
      { page, screen: SCREEN, config: testConfig() },
      ['live'],
    );
    expect(result.gaps).toEqual([]);
    expect(result.drafts).toEqual([]);
    expect(designAxTree).toHaveBeenCalledTimes(2);
  });

  it('is read again after a target size check, because its scroll can make page script change the page', async () => {
    const designAxTree = vi.fn(async () => ({ kind: 'tree' as const, nodes: treeOf([button('Refresh')]) }));
    const page = pageWith(
      { '#r': button('Refresh') },
      { designAxTree, boundingBox: async () => ({ width: 44, height: 44, fragments: 1, unmeasurable: [] }) },
    );
    const result = await runProviders(
      providersOf([req({ type: 'target-size', target: { role: 'button', name: 'Refresh' }, minCssPx: 24 }), nameReq('r-after', 'Refresh')]),
      { page, screen: SCREEN, config: testConfig() },
      ['live'],
    );
    expect(result.gaps).toEqual([]);
    expect(result.drafts).toEqual([]);
    expect(designAxTree).toHaveBeenCalledTimes(2);
  });

  it('is never the read the silent change rule makes, which has a time budget', async () => {
    const fullAxTree = vi.fn(async () => ({ kind: 'over-budget' as const, limit: 'time' as const }));
    const page = pageWith({ '#r': button('Refresh') }, { fullAxTree });
    expect(await run(req({ type: 'name', target: { role: 'button', name: 'Refresh' } }), page)).toEqual([]);
    expect(fullAxTree).not.toHaveBeenCalled();
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
    const page = pageWith({}, { designAxTree: async () => ({ kind: 'tree', nodes: treeOf([main]) }) });
    const drafts = await run(req({ type: 'landmark', role: 'main' }), page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
  });

  it('is unconfirmed, never a fail, and names the limit, when the tree has more nodes than usabl reads', async () => {
    const page = pageWith({}, { designAxTree: async () => ({ kind: 'over-limit', limit: DESIGN_AX_TREE_NODE_LIMIT }) });
    const drafts = await run(req({ type: 'landmark', role: 'main' }), page);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toBe(
      `usabl found none in the page document. The page's accessibility tree has more than ${DESIGN_AX_TREE_NODE_LIMIT} nodes, the most usabl reads for a design check, so it cannot make sure there is none.`,
    );
  });

  it('is unconfirmed, never a fail, when the accessibility tree answer could not be read', async () => {
    const page = pageWith({}, { designAxTree: async () => ({ kind: 'unreadable' }) });
    const drafts = await run(req({ type: 'landmark', role: 'main' }), page);
    expect(drafts.map((d) => d.confidence)).toEqual(['unverified']);
    expect(drafts[0]?.why).toBe(
      'usabl found none in the page document. The browser gave an accessibility tree usabl could not read, so it cannot make sure there is none.',
    );
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

  it('reads each name with the one white space rule the name check uses: ASCII white space only', async () => {
    const one = req({ type: 'focus-order', sequence: ['Refresh'] });
    expect(await run(one, tabbingPage([' Refresh\n']))).toEqual([]);
    // A no-break space is not ASCII white space, so it is part of the name, for both checks. The
    // name check then asks for review and names the character, because a person cannot see it.
    const focus = await run(one, tabbingPage(['Refresh ']));
    expect(focus[0]?.confidence).toBe('fail');
    expect(focus[0]?.evidence.extra).toMatchObject({ heard: ['Refresh '] });
    const name = await run(req({ type: 'name', target: { role: 'button', name: 'Refresh' } }), pageWith({ '#r': button('Refresh ') }));
    expect(name[0]?.confidence).toBe('unverified');
    expect(name[0]?.why).toContain('"Refresh" followed by a no-break space');
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

  // One box with nothing that stops usabl measuring it, unless the case says otherwise.
  function sized(box: { width: number; height: number; fragments?: number; unmeasurable?: BoxLimit[] } | null): Page {
    const read = box === null ? null : { fragments: 1, unmeasurable: [], ...box };
    return pageWith({ '#r': button('Refresh') }, { boundingBox: async () => read });
  }

  it.each([
    ['rotated-or-skewed', 'rotated or skewed'],
    ['clip-path', 'clip-path'],
    ['mask', 'mask'],
    ['overflow-clipped', 'hides or scrolls its overflow'],
    ['outside-viewport', 'past the edge of the viewport'],
    ['hit-test-missed', "part of the control's box cannot be hit"],
    ['size-changed-on-scroll', 'the control changed size when it was scrolled into view'],
  ] as const)('is unconfirmed, never a pass, when the box read says %s', async (limit, reason) => {
    // A box large enough to pass, so only the limit can keep it from passing.
    const drafts = await run(r, sized({ width: 44, height: 44, unmeasurable: [limit] }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toContain(reason);
    expect(drafts[0]?.evidence.extra).toMatchObject({ unmeasurable: [limit] });
  });

  it('names every limit the box read found, in a fixed order', async () => {
    const drafts = await run(r, sized({ width: 44, height: 44, unmeasurable: ['clip-path', 'rotated-or-skewed'] }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.why).toMatch(/rotated or skewed.*clip-path/u);
  });

  it('is unconfirmed, never a pass, when the box read names a limit the check has no words for', async () => {
    // A limit added to the box read alone must still stop a pass.
    const alone = await run(r, sized({ width: 44, height: 44, unmeasurable: ['some-new-limit' as BoxLimit] }));
    expect(alone.map((d) => d.confidence)).toEqual(['unverified']);
    const drafts = await run(r, sized({ width: 44, height: 44, unmeasurable: ['some-new-limit' as BoxLimit, 'clip-path'] }));
    expect(drafts.map((d) => d.confidence)).toEqual(['unverified']);
    expect(drafts[0]?.why).toMatch(/clip-path.*a reason usabl has no description for \(some-new-limit\)/u);
    expect(drafts[0]?.evidence.extra).toMatchObject({ unmeasurable: ['clip-path', 'some-new-limit'] });
  });

  it('names a missed hit test last, after the shapes it lists by name', async () => {
    const drafts = await run(r, sized({ width: 44, height: 44, unmeasurable: ['hit-test-missed', 'overflow-clipped'] }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.why).toMatch(/hides or scrolls its overflow.*cannot be hit/u);
    expect(drafts[0]?.evidence.extra).toMatchObject({ unmeasurable: ['overflow-clipped', 'hit-test-missed'] });
  });

  it('is unconfirmed, never a pass, when only the hit test missed and the box is large enough', async () => {
    // The box read alone would pass: the hit test is the last gate before a pass.
    const drafts = await run(r, sized({ width: 60, height: 60, unmeasurable: ['hit-test-missed'] }));
    expect(drafts.map((d) => d.confidence)).toEqual(['unverified']);
    expect(drafts[0]?.why).toContain('does not take pointer events');
    expect(drafts[0]?.why).toContain('partly off the page');
  });

  it('is unconfirmed, never a pass, when the element is laid out in more than one box', async () => {
    // An inline link that wraps onto two lines: the union of its boxes is large, each box may not be.
    const drafts = await run(r, sized({ width: 120, height: 40, fragments: 2 }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.why).toContain('laid out in 2 boxes');
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
    const page = pageWith({ '#a': button('Refresh'), '#b': button('Refresh') }, { boundingBox: async () => ({ width: 1, height: 1, fragments: 1, unmeasurable: [] }) });
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
