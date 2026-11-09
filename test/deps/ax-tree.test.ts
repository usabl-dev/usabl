/**
 * The whole accessibility tree as the silent change rule reads it. The browser computes the tree
 * over CDP, and this unit only keeps what a change is judged on: identity by backend node id,
 * the parent chain, role, name, six states, aria-busy, and aria-controls. Values are never read,
 * and a read past its budget in time or in nodes is not a tree.
 */
import { describe, expect, it } from 'vitest';
import { AX_TREE_NODE_BUDGET, AX_TREE_TIME_BUDGET_MS, axTreeFromCdp, readFullAxTree, sortStateFrom } from '../../src/deps/ax-tree.js';
import { makeFakePage } from '../../src/deps/fakes.js';

function prop(name: string, value: unknown, type = 'booleanOrUndefined'): unknown {
  return { name, value: { type, value } };
}

// A small tree in the shape Accessibility.getFullAXTree returns it.
const RAW = {
  nodes: [
    { nodeId: '1', backendDOMNodeId: 1, ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Rows' }, childIds: ['2'] },
    { nodeId: '2', backendDOMNodeId: 2, ignored: true, role: { value: 'none' }, parentId: '1', childIds: ['3', '6', '9'] },
    {
      nodeId: '3',
      backendDOMNodeId: 3,
      ignored: false,
      role: { value: 'button' },
      name: { value: 'More' },
      parentId: '2',
      childIds: ['4'],
      properties: [
        prop('focusable', true),
        prop('expanded', true),
        prop('invalid', 'false', 'token'),
        { name: 'controls', value: { type: 'idrefList', value: 'panel', relatedNodes: [{ backendDOMNodeId: 9, idref: 'panel' }] } },
      ],
    },
    { nodeId: '4', backendDOMNodeId: 4, ignored: false, role: { value: 'StaticText' }, name: { value: 'More' }, parentId: '3', childIds: ['5'] },
    // An inline text box has no DOM node, so it has no identity across reads and is left out.
    { nodeId: '-100', ignored: false, role: { value: 'InlineTextBox' }, name: { value: 'More' }, parentId: '4', childIds: [] },
    {
      nodeId: '6',
      backendDOMNodeId: 6,
      ignored: false,
      role: { value: 'textbox' },
      name: { value: 'Email' },
      value: { type: 'string', value: 'alice@example.com' },
      parentId: '2',
      childIds: ['7'],
      properties: [prop('editable', 'plaintext', 'token'), prop('checked', 'mixed', 'tristate')],
    },
    // The inner editor of a field holds its value as text. It is never read.
    { nodeId: '7', backendDOMNodeId: 7, ignored: false, role: { value: 'generic' }, name: { value: '' }, parentId: '6', childIds: ['8'], properties: [prop('editable', 'plaintext', 'token')] },
    { nodeId: '8', backendDOMNodeId: 8, ignored: false, role: { value: 'StaticText' }, name: { value: 'alice@example.com' }, parentId: '7', childIds: [] },
    {
      nodeId: '9',
      backendDOMNodeId: 9,
      ignored: false,
      role: { value: 'region' },
      name: { value: 'Panel' },
      parentId: '2',
      childIds: [],
      properties: [prop('busy', 1, 'boolean'), prop('selected', false), prop('pressed', 'true', 'tristate'), prop('focused', true)],
    },
  ],
};

describe('axTreeFromCdp', () => {
  const tree = axTreeFromCdp(RAW);

  it('keys every node by its DOM backend node id and names the document', () => {
    expect(tree.documentNodeId).toBe(1);
    expect(tree.nodes.map((node) => node.nodeId)).toEqual([1, 2, 3, 4, 6, 9]);
  });

  it('keeps the parent chain through ignored nodes', () => {
    expect(tree.nodes.find((node) => node.nodeId === 3)?.parentId).toBe(2);
    expect(tree.nodes.find((node) => node.nodeId === 2)).toMatchObject({ ignored: true, name: null, parentId: 1 });
  });

  it('reads only the six judged states, aria-busy, and aria-controls', () => {
    expect(tree.nodes.find((node) => node.nodeId === 3)).toEqual({
      nodeId: 3,
      parentId: 2,
      role: 'button',
      name: 'More',
      ignored: false,
      states: { expanded: 'true', invalid: 'false' },
      busy: false,
      controls: [9],
    });
    expect(tree.nodes.find((node) => node.nodeId === 9)).toMatchObject({
      states: { selected: 'false', pressed: 'true' },
      busy: true,
    });
  });

  it('never reads a value: a field keeps its name and states, and the text inside it is left out', () => {
    expect(tree.nodes.find((node) => node.nodeId === 6)).toMatchObject({ role: 'textbox', name: 'Email', states: { checked: 'mixed' } });
    expect(tree.nodes.some((node) => node.nodeId === 7 || node.nodeId === 8)).toBe(false);
    expect(JSON.stringify(tree)).not.toContain('alice@example.com');
  });

  it('reads nothing from a response that is not a tree', () => {
    expect(axTreeFromCdp(null)).toEqual({ documentNodeId: null, nodes: [] });
    expect(axTreeFromCdp({ nodes: 'x' })).toEqual({ documentNodeId: null, nodes: [] });
  });
});

describe('sortStateFrom', () => {
  it('reads aria-sort the way the browser computes it: a known token in any case, anything else none', () => {
    expect(sortStateFrom(['aria-sort', 'Ascending'])).toBe('ascending');
    expect(sortStateFrom(['id', 'h', 'aria-sort', ' descending '])).toBe('descending');
    expect(sortStateFrom(['aria-sort', 'other'])).toBe('other');
    expect(sortStateFrom(['aria-sort', 'upward'])).toBe('none');
    expect(sortStateFrom(['id', 'h'])).toBeNull();
    expect(sortStateFrom(undefined)).toBeNull();
  });
});

describe('readFullAxTree', () => {
  const header = {
    nodes: [
      { nodeId: '1', backendDOMNodeId: 1, ignored: false, role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['2'] },
      { nodeId: '2', backendDOMNodeId: 2, ignored: false, role: { value: 'columnheader' }, name: { value: 'Name' }, parentId: '1', childIds: [] },
    ],
  };

  it('adds the sort state of each header from the browser DOM read', async () => {
    const calls: Array<[string, unknown]> = [];
    const send = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      calls.push([method, params]);
      if (method === 'Accessibility.getFullAXTree') return header;
      return { node: { attributes: ['aria-sort', 'ascending'] } };
    };

    const read = await readFullAxTree(send, () => 0);

    expect(read.kind).toBe('tree');
    if (read.kind !== 'tree') return;
    expect(read.nodes.find((node) => node.nodeId === 2)?.states).toEqual({ sort: 'ascending' });
    expect(calls).toEqual([
      ['Accessibility.getFullAXTree', undefined],
      ['DOM.describeNode', { backendNodeId: 2 }],
    ]);
  });

  it(`is over budget past ${AX_TREE_NODE_BUDGET} nodes, before it reads any of them`, async () => {
    const many = { nodes: Array.from({ length: AX_TREE_NODE_BUDGET + 1 }, (_, index) => ({ nodeId: String(index + 1), backendDOMNodeId: index + 1 })) };
    expect(await readFullAxTree(async () => many, () => 0)).toEqual({ kind: 'over-budget', limit: 'nodes' });
  });

  it(`is over budget when the read takes longer than ${AX_TREE_TIME_BUDGET_MS} ms`, async () => {
    let clock = 0;
    const send = async (method: string): Promise<unknown> => {
      clock += method === 'Accessibility.getFullAXTree' ? AX_TREE_TIME_BUDGET_MS + 1 : 0;
      return method === 'Accessibility.getFullAXTree' ? header : { node: { attributes: [] } };
    };
    expect(await readFullAxTree(send, () => clock)).toEqual({ kind: 'over-budget', limit: 'time' });
  });

  it('holds exactly the budget the ground truth states', () => {
    expect(AX_TREE_TIME_BUDGET_MS).toBe(500);
    expect(AX_TREE_NODE_BUDGET).toBe(5000);
  });
});

describe('a fake page', () => {
  it('has an empty tree that never changes and no focused node, unless a test scripts them', async () => {
    const page = makeFakePage();
    expect(await page.fullAxTree()).toEqual({ kind: 'tree', documentNodeId: null, nodes: [] });
    expect(await page.focusedNodeId()).toBeNull();
  });

  it('cannot resolve the control a click step names, because it has no DOM', async () => {
    expect(await makeFakePage().controlNodeId('#save')).toBeNull();
  });
});
