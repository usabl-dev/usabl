/**
 * The tree comparison the silent change rule reads. Two reads of the whole accessibility tree, one
 * before an action step and one after its settle window, give what changed outside the control's
 * own change: nodes added or removed, and names or judged states that changed. The control's own
 * change is its own states, the states of its ancestors, and, when its own state changed in the
 * same step, the nodes its aria-controls names. A disclosure, a tab, and a sort header speak for
 * themselves, and the voicing tier already checks that speech.
 */
import { describe, expect, it } from 'vitest';
import type { AxTreeNode } from '../../src/contracts/index.js';
import { compareAxTrees, isNoChange, type TreeChange } from '../../src/voicing/tree-change.js';

function node(nodeId: number, parentId: number | null, role: string, name: string | null, extra: Partial<AxTreeNode> = {}): AxTreeNode {
  return { nodeId, parentId, role, name, ignored: false, states: {}, busy: false, controls: [], ...extra };
}

const NONE: TreeChange = { added: {}, removed: {}, changed: {}, addedNames: [] };

// A page with a main landmark, a Save button, and a status region.
function base(): AxTreeNode[] {
  return [
    node(1, null, 'RootWebArea', 'Rows'),
    node(2, 1, 'main', ''),
    node(3, 2, 'button', 'Save'),
    node(4, 3, 'StaticText', 'Save'),
    node(5, 2, 'status', ''),
  ];
}

describe('compareAxTrees', () => {
  it('finds no change between two equal trees, whatever their order', () => {
    expect(compareAxTrees(base(), [...base()].reverse(), 3)).toEqual(NONE);
    expect(isNoChange(compareAxTrees(base(), base(), 3))).toBe(true);
  });

  it('counts a node added, by role, and names it', () => {
    const after = [...base(), node(6, 5, 'StaticText', 'Saved')];
    expect(compareAxTrees(base(), after, 3)).toEqual({ ...NONE, added: { StaticText: 1 }, addedNames: ['Saved'] });
  });

  it('counts a node removed by role and never names it', () => {
    const before = [...base(), node(10, 2, 'row', 'alice@example.com'), node(11, 10, 'cell', 'alice@example.com')];
    const change = compareAxTrees(before, base(), 3);
    expect(change).toEqual({ ...NONE, removed: { cell: 1, row: 1 } });
    expect(JSON.stringify(change)).not.toContain('alice');
  });

  it('counts a node that stops being ignored as added, and one that becomes ignored as removed', () => {
    const hidden = [...base(), node(7, 2, 'region', null, { ignored: true })];
    const shown = [...base(), node(7, 2, 'region', 'Details')];
    expect(compareAxTrees(hidden, shown, 3)).toEqual({ ...NONE, added: { region: 1 }, addedNames: ['Details'] });
    expect(compareAxTrees(shown, hidden, 3)).toEqual({ ...NONE, removed: { region: 1 } });
  });

  it('counts a name that changed outside the control, and never names it', () => {
    const before = [...base(), node(8, 2, 'heading', '3 rows')];
    const after = [...base(), node(8, 2, 'heading', '2 rows')];
    expect(compareAxTrees(before, after, 3)).toEqual({ ...NONE, changed: { heading: 1 } });
  });

  it('counts a judged state that changed on a node outside the control', () => {
    const before = [...base(), node(9, 2, 'checkbox', 'Select all', { states: { checked: 'false' } })];
    const after = [...base(), node(9, 2, 'checkbox', 'Select all', { states: { checked: 'true' } })];
    expect(compareAxTrees(before, after, 3)).toEqual({ ...NONE, changed: { checkbox: 1 } });
  });

  it('reads the control own states as its own change', () => {
    const before = base().map((entry) => (entry.nodeId === 3 ? { ...entry, states: { pressed: 'false' } } : entry));
    const after = base().map((entry) => (entry.nodeId === 3 ? { ...entry, states: { pressed: 'true' } } : entry));
    expect(compareAxTrees(before, after, 3)).toEqual(NONE);
  });

  it('counts a name change on the control itself, which the rule reads with focus', () => {
    const after = base().map((entry) => (entry.nodeId === 3 || entry.nodeId === 4 ? { ...entry, name: 'Saved' } : entry));
    expect(compareAxTrees(base(), after, 3)).toEqual({ ...NONE, changed: { StaticText: 1, button: 1 } });
  });

  it('reads the states of the control ancestors as its own change, but not their names', () => {
    const before = [node(1, null, 'RootWebArea', ''), node(2, 1, 'treeitem', 'Folder', { states: { expanded: 'false' } }), node(3, 2, 'button', 'Toggle')];
    const statesOnly = [node(1, null, 'RootWebArea', ''), node(2, 1, 'treeitem', 'Folder', { states: { expanded: 'true' } }), node(3, 2, 'button', 'Toggle')];
    const renamed = [node(1, null, 'RootWebArea', ''), node(2, 1, 'treeitem', 'Folder (open)', { states: { expanded: 'true' } }), node(3, 2, 'button', 'Toggle')];
    expect(compareAxTrees(before, statesOnly, 3)).toEqual(NONE);
    expect(compareAxTrees(before, renamed, 3)).toEqual({ ...NONE, changed: { treeitem: 1 } });
  });

  describe('a disclosure', () => {
    // The browser exposes aria-controls only once the panel is shown, so the after read names it.
    const before = [node(1, null, 'RootWebArea', ''), node(2, 1, 'button', 'Details', { states: { expanded: 'false' } })];
    const after = [
      node(1, null, 'RootWebArea', ''),
      node(2, 1, 'button', 'Details', { states: { expanded: 'true' }, controls: [5] }),
      node(5, 1, 'generic', null, { ignored: true }),
      node(6, 5, 'paragraph', ''),
      node(7, 6, 'StaticText', 'Shipping takes three days'),
    ];

    it('speaks for itself: the panel its aria-controls names, and everything in it, is its own change', () => {
      expect(compareAxTrees(before, after, 2)).toEqual(NONE);
    });

    it('does not, when its own state did not change in the same step', () => {
      const unchanged = after.map((entry) => (entry.nodeId === 2 ? { ...entry, states: { expanded: 'false' } } : entry));
      expect(compareAxTrees(before, unchanged, 2)).toEqual({
        ...NONE,
        added: { StaticText: 1, paragraph: 1 },
        addedNames: ['Shipping takes three days'],
      });
    });

    it('does not, when the control cannot be named', () => {
      expect(isNoChange(compareAxTrees(before, after, null))).toBe(false);
    });
  });

  describe('a tab', () => {
    const tabs = (selected: 1 | 2): AxTreeNode[] => [
      node(1, null, 'RootWebArea', ''),
      node(2, 1, 'tablist', ''),
      node(3, 2, 'tab', 'One', { states: { selected: String(selected === 1) }, controls: selected === 1 ? [10] : [] }),
      node(4, 2, 'tab', 'Two', { states: { selected: String(selected === 2) }, controls: selected === 2 ? [20] : [] }),
      ...(selected === 1
        ? [node(10, 1, 'tabpanel', 'One'), node(11, 10, 'StaticText', 'First panel')]
        : [node(20, 1, 'tabpanel', 'Two'), node(21, 20, 'StaticText', 'Second panel')]),
    ];

    it('speaks for itself: its panel shown, and the tab it replaced with that tab panel hidden', () => {
      expect(compareAxTrees(tabs(1), tabs(2), 4)).toEqual(NONE);
    });

    it('does not exempt the panel of a tab that was removed, because only a tab still there was deselected', () => {
      // Tab One and its panel are gone after the step, not deselected.
      const after = tabs(2).filter((entry) => entry.nodeId !== 3);
      const before = [...tabs(1)];
      expect(compareAxTrees(before, after, 4)).toEqual({ ...NONE, removed: { StaticText: 1, tab: 1, tabpanel: 1 } });
    });

    it('still counts a change outside both tabs and both panels', () => {
      const after = [...tabs(2), node(30, 1, 'status', 'Loaded')];
      expect(compareAxTrees(tabs(1), after, 4)).toEqual({ ...NONE, added: { status: 1 }, addedNames: ['Loaded'] });
    });
  });

  describe('a sort header', () => {
    const table = (sort: string, order: number[]): AxTreeNode[] => [
      node(1, null, 'RootWebArea', ''),
      node(2, 1, 'table', ''),
      node(3, 2, 'columnheader', 'Name', { states: { sort } }),
      node(4, 3, 'button', 'Name'),
      ...order.map((id) => node(id, 2, 'row', '')),
    ];

    it('speaks for itself: the sort state on its header, and rows that only moved', () => {
      expect(compareAxTrees(table('none', [10, 11, 12]), table('ascending', [12, 10, 11]), 4)).toEqual(NONE);
    });
  });

  it('names added nodes once each, sorted', () => {
    const after = [...base(), node(6, 5, 'StaticText', 'b'), node(7, 5, 'StaticText', 'a'), node(8, 5, 'StaticText', 'b'), node(9, 5, 'generic', '')];
    expect(compareAxTrees(base(), after, 3)).toEqual({ ...NONE, added: { StaticText: 3, generic: 1 }, addedNames: ['a', 'b'] });
  });
});
