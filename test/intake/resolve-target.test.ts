import { describe, expect, it, vi } from 'vitest';
import type { AxNode, AxTreeNode, ElementRef, Page } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { findByRole, resolveTarget, ROLE_CANDIDATES } from '../../src/intake/resolve-target.js';

// The whole accessibility tree a browser would build from these nodes: one perceived node for each
// element it does not ignore, and any nodes the document query cannot see.
function treeOf(nodes: ReadonlyArray<AxNode | null>): AxTreeNode[] {
  return nodes.flatMap((node, index) =>
    node === null
      ? []
      : [{ nodeId: index + 1, parentId: null, role: node.role, name: node.name, ignored: false, states: {}, busy: false, controls: [] }],
  );
}

function pageWith(nodes: Record<string, AxNode | null>, everywhere?: number, hiddenFromQuery: AxNode[] = []): Page {
  const refs: ElementRef[] = Object.keys(nodes).map((selector) => ({ selector }));
  return makeFakePage({
    queryAll: async () => refs,
    axAt: async (selector: string) => nodes[selector] ?? null,
    countEverywhere: async () => everywhere ?? refs.length,
    designAxTree: async () => ({ kind: 'tree', nodes: treeOf([...Object.values(nodes), ...hiddenFromQuery]) }),
  });
}

const button = (name: string | null): AxNode => ({ name, role: 'button', states: {} });

describe('resolveTarget', () => {
  it('finds the one element whose role and accessible name match', async () => {
    const page = pageWith({ '#a': button('Refresh'), '#b': button('Delete') });
    const found = await resolveTarget(page, { role: 'button', name: 'Refresh' });
    expect(found).toEqual({ kind: 'one', match: { selector: '#a', node: button('Refresh') } });
  });

  it('ignores surrounding spaces and keeps case', async () => {
    const page = pageWith({ '#a': button(' Refresh ') });
    expect((await resolveTarget(page, { role: 'button', name: 'Refresh' })).kind).toBe('one');
    expect((await resolveTarget(page, { role: 'button', name: 'refresh' })).kind).toBe('none');
  });

  it('reads a run of white space inside a name as one space, on both sides', async () => {
    const page = pageWith({ '#a': button('Create  user') });
    expect((await resolveTarget(page, { role: 'button', name: 'Create user' })).kind).toBe('one');
  });

  it('uses the accessibility tree role, not the tag', async () => {
    const page = pageWith({ '#a': { name: 'Refresh', role: 'generic', states: {} } });
    expect((await resolveTarget(page, { role: 'button', name: 'Refresh' })).kind).toBe('none');
  });

  it('accepts both role names Chromium uses for images and search fields', async () => {
    const image = pageWith({ '#a': { name: 'Team photo', role: 'image', states: {} } });
    expect((await resolveTarget(image, { role: 'img', name: 'Team photo' })).kind).toBe('one');
    const search = pageWith({ '#s': { name: 'Filter users', role: 'searchbox', states: {} } });
    expect((await resolveTarget(search, { role: 'textbox', name: 'Filter users' })).kind).toBe('one');
  });

  it('skips an element the accessibility tree ignores', async () => {
    const page = pageWith({ '#hidden': null, '#a': button('Refresh') });
    expect((await resolveTarget(page, { role: 'button', name: 'Refresh' })).kind).toBe('one');
  });

  it('refuses to pick when more than one element matches, because which one is meant would be a guess', async () => {
    const page = pageWith({ '#a': button('Delete'), '#b': button('Delete') });
    expect(await resolveTarget(page, { role: 'button', name: 'Delete' })).toEqual({ kind: 'many', count: 2 });
  });

  it('reports no match as none', async () => {
    const page = pageWith({ '#a': button('Delete') });
    expect(await resolveTarget(page, { role: 'button', name: 'Refresh' })).toEqual({ kind: 'none' });
  });

  it('refuses when candidates sit where it cannot read them, such as a shadow root or a frame', async () => {
    // Two buttons in the page, one more the document query cannot see.
    const one = pageWith({ '#a': button('Refresh'), '#b': button('Delete') }, 3);
    expect(await resolveTarget(one, { role: 'button', name: 'Refresh' })).toEqual({
      kind: 'out-of-reach',
      found: 1,
      outOfReach: 1,
    });
    const none = pageWith({ '#b': button('Delete') }, 2);
    expect(await resolveTarget(none, { role: 'button', name: 'Refresh' })).toEqual({
      kind: 'out-of-reach',
      found: 0,
      outOfReach: 1,
    });
  });

  it('still refuses as many when two readable elements match, whatever else is out of reach', async () => {
    const page = pageWith({ '#a': button('Delete'), '#b': button('Delete') }, 5);
    expect(await resolveTarget(page, { role: 'button', name: 'Delete' })).toEqual({ kind: 'many', count: 2 });
  });

  it('asks the page with one fixed selector per role, never with design text', async () => {
    const queryAll = vi.fn(async () => [] as ElementRef[]);
    const countEverywhere = vi.fn(async () => 0);
    const page = makeFakePage({ queryAll, countEverywhere });
    await resolveTarget(page, { role: 'button', name: '"], script, [x="' });
    expect(queryAll).toHaveBeenCalledTimes(1);
    const [selector] = queryAll.mock.calls[0] as unknown as [string];
    expect(selector).not.toContain('script');
    expect(countEverywhere).toHaveBeenCalledWith(selector);
  });

  it('matches a role attribute by token, because the browser reads the first role it knows', () => {
    for (const selector of Object.values(ROLE_CANDIDATES)) {
      expect(selector).not.toMatch(/\[role="/u);
    }
    expect(ROLE_CANDIDATES.button).toContain('[role~="button"]');
  });

  it('reads two matches when the tree has a second one in a closed shadow root or set by ElementInternals', async () => {
    // The document query sees one Refresh button, and Playwright does not count the other.
    const page = pageWith({ '#a': button('Refresh') }, 1, [button('Refresh')]);
    expect(await resolveTarget(page, { role: 'button', name: 'Refresh' })).toEqual({ kind: 'many', count: 2 });
  });

  it('refuses to pick when a candidate read came back empty and the tree holds a second match', async () => {
    // '#b' re-rendered between the query and the read, so its read is empty, and the tree, read
    // after, holds it.
    const refs: ElementRef[] = [{ selector: '#a' }, { selector: '#b' }];
    const page = makeFakePage({
      queryAll: async () => refs,
      axAt: async (selector: string) => (selector === '#a' ? button('Refresh') : null),
      countEverywhere: async () => 2,
      designAxTree: async () => ({ kind: 'tree', nodes: treeOf([button('Refresh'), button('Refresh')]) }),
    });
    expect((await resolveTarget(page, { role: 'button', name: 'Refresh' })).kind).toBe('many');
  });

  it('cannot tell when the tree has one match the document search did not read', async () => {
    const page = pageWith({ '#b': button('Delete') }, 1, [button('Refresh')]);
    expect(await resolveTarget(page, { role: 'button', name: 'Refresh' })).toEqual({
      kind: 'cannot-tell',
      reason: 'tree-differs',
      found: 0,
      inTree: 1,
    });
  });

  it('cannot tell when the tree has fewer matches than the document search read', async () => {
    const page = makeFakePage({
      queryAll: async () => [{ selector: '#a' }],
      axAt: async () => button('Refresh'),
      countEverywhere: async () => 1,
      designAxTree: async () => ({ kind: 'tree', nodes: [] }),
    });
    expect(await resolveTarget(page, { role: 'button', name: 'Refresh' })).toEqual({
      kind: 'cannot-tell',
      reason: 'tree-differs',
      found: 1,
      inTree: 0,
    });
  });

  it('cannot tell when the tree has more nodes than usabl reads', async () => {
    const page = makeFakePage({
      queryAll: async () => [{ selector: '#a' }],
      axAt: async () => button('Refresh'),
      countEverywhere: async () => 1,
      designAxTree: async () => ({ kind: 'over-limit', limit: 20000 }),
    });
    expect(await resolveTarget(page, { role: 'button', name: 'Refresh' })).toEqual({
      kind: 'cannot-tell',
      reason: 'tree-over-limit',
      found: 1,
      inTree: null,
    });
  });

  it('reads the tree from the source it is given, so callers can share one read', async () => {
    const designAxTree = vi.fn(async () => ({ kind: 'tree' as const, nodes: [] }));
    const page = makeFakePage({
      queryAll: async () => [{ selector: '#a' }],
      axAt: async () => button('Refresh'),
      countEverywhere: async () => 1,
      designAxTree,
    });
    const shared = Promise.resolve({ kind: 'tree' as const, nodes: treeOf([button('Refresh')]) });
    expect((await resolveTarget(page, { role: 'button', name: 'Refresh' }, () => shared)).kind).toBe('one');
    expect(designAxTree).not.toHaveBeenCalled();
  });

  it('does not count a node the tree ignores', async () => {
    const page = makeFakePage({
      queryAll: async () => [{ selector: '#a' }, { selector: '#hidden' }],
      axAt: async (selector: string) => (selector === '#a' ? button('Refresh') : null),
      countEverywhere: async () => 2,
      designAxTree: async () => ({
        kind: 'tree',
        nodes: [
          ...treeOf([button('Refresh')]),
          { nodeId: 9, parentId: null, role: 'button', name: null, ignored: true, states: {}, busy: false, controls: [] },
        ],
      }),
    });
    expect((await resolveTarget(page, { role: 'button', name: 'Refresh' })).kind).toBe('one');
  });
});

describe('findByRole', () => {
  it('lists every readable element with a role, for landmark checks', async () => {
    const page = pageWith({ '#m': { name: null, role: 'main', states: {} }, '#x': { name: null, role: 'generic', states: {} } });
    const found = await findByRole(page, 'main');
    expect(found.matches.map((m) => m.selector)).toEqual(['#m']);
    expect(found.outOfReach).toBe(0);
  });
});
