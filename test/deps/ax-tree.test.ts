/**
 * The whole accessibility tree as the silent change rule reads it. The browser computes the tree
 * over CDP, and this unit only keeps what a change is judged on: identity by backend node id,
 * the parent chain, role, name, six states, aria-busy, and aria-controls. Values are never read,
 * and a read past its budget in time or in nodes is not a tree.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AX_TREE_NODE_BUDGET,
  AX_TREE_TIME_BUDGET_MS,
  DESIGN_AX_TREE_NODE_LIMIT,
  axTreeFromCdp,
  readDesignAxTree,
  readFullAxTree,
  sortStateFrom,
} from '../../src/deps/ax-tree.js';
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

  describe('a node that holds a field', () => {
    // The browser can build such a node's name from its contents, and the contents include the
    // field's value. Each name lists where it comes from; the first source with a value that is not
    // superseded is the one the browser used.
    const contents = (value: string): unknown => ({ value, sources: [{ type: 'attribute', attribute: 'aria-label' }, { type: 'contents', value: { value } }] });
    const labelled = (value: string): unknown => ({ value, sources: [{ type: 'attribute', attribute: 'aria-label', value: { value } }, { type: 'contents', superseded: true, value: { value: 'x' } }] });
    const FIELDS = {
      nodes: [
        { nodeId: '1', backendDOMNodeId: 1, ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Rows' }, childIds: ['10', '20', '30', '40'] },
        // A row named from its contents, which hold a field with an email address in it.
        { nodeId: '10', backendDOMNodeId: 10, ignored: false, role: { value: 'row' }, name: contents('alice@example.com'), parentId: '1', childIds: ['11'] },
        { nodeId: '11', backendDOMNodeId: 11, ignored: false, role: { value: 'cell' }, name: contents('alice@example.com'), parentId: '10', childIds: ['12'] },
        {
          nodeId: '12',
          backendDOMNodeId: 12,
          ignored: false,
          role: { value: 'textbox' },
          name: labelled('Email'),
          parentId: '11',
          childIds: [],
          properties: [prop('editable', 'plaintext', 'token')],
        },
        // A button with an author-given name keeps it, even though it holds a field.
        { nodeId: '20', backendDOMNodeId: 20, ignored: false, role: { value: 'button' }, name: labelled('Delete row'), parentId: '1', childIds: ['21'] },
        { nodeId: '21', backendDOMNodeId: 21, ignored: false, role: { value: 'textbox' }, name: { value: '' }, parentId: '20', childIds: [], properties: [prop('editable', 'plaintext', 'token')] },
        // A name that does not say where it comes from may come from the field.
        { nodeId: '30', backendDOMNodeId: 30, ignored: false, role: { value: 'option' }, name: { value: 'bob@example.com' }, parentId: '1', childIds: ['31'] },
        { nodeId: '31', backendDOMNodeId: 31, ignored: false, role: { value: 'textbox' }, name: { value: '' }, parentId: '30', childIds: [], properties: [prop('editable', 'plaintext', 'token')] },
        // A node with no field under it keeps a name from its contents.
        { nodeId: '40', backendDOMNodeId: 40, ignored: false, role: { value: 'button' }, name: contents('Save'), parentId: '1', childIds: [] },
      ],
    };
    const read = axTreeFromCdp(FIELDS);
    const nameOf = (nodeId: number): string | null | undefined => read.nodes.find((node) => node.nodeId === nodeId)?.name;

    it('drops a name built from contents, and one that does not say where it comes from', () => {
      expect(nameOf(10)).toBeNull();
      expect(nameOf(11)).toBeNull();
      expect(nameOf(30)).toBeNull();
      expect(JSON.stringify(read)).not.toContain('example.com');
    });

    it('keeps an author-given name, the field own name, and names away from any field', () => {
      expect(nameOf(20)).toBe('Delete row');
      expect(nameOf(12)).toBe('Email');
      expect(nameOf(40)).toBe('Save');
    });
  });

  describe('a control whose value is user data', () => {
    // Shaped as Chromium gives them. A cell built from its contents takes the value of a slider,
    // a spin button, a progress bar, or the option a select shows. An option's name is its text.
    const contents = (value: string): unknown => ({ value, sources: [{ type: 'attribute', attribute: 'aria-label' }, { type: 'contents', value: { value } }] });
    const labelled = (value: string): unknown => ({ value, sources: [{ type: 'attribute', attribute: 'aria-label', value: { value } }, { type: 'contents', superseded: true, value: { value: 'x' } }] });
    const node = (nodeId: number, parentId: number, role: string, name: unknown, properties: unknown[] = []): unknown => ({
      nodeId: String(nodeId),
      backendDOMNodeId: nodeId,
      ignored: false,
      role: { value: role },
      name,
      parentId: String(parentId),
      childIds: [],
      properties,
    });
    const VALUES = {
      nodes: [
        { nodeId: '1', backendDOMNodeId: 1, ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Rows' }, childIds: [] },
        // A slider.
        node(50, 1, 'row', contents('417')),
        node(51, 50, 'cell', contents('417')),
        node(52, 51, 'slider', labelled('Age'), [prop('valuetext', '417', 'string')]),
        // A select: the combobox, its popup, and its options.
        node(60, 1, 'cell', contents('alice@example.com')),
        node(61, 60, 'combobox', labelled('Owner'), [prop('expanded', false)]),
        node(62, 61, 'MenuListPopup', { value: '' }),
        node(63, 62, 'option', contents('alice@example.com'), [prop('selected', true)]),
        // A list box, an option with an author-given name, and a checkbox inside it.
        node(70, 1, 'cell', contents('bob@example.com')),
        node(71, 70, 'listbox', labelled('Owners')),
        node(72, 71, 'option', labelled('carol@example.com'), [prop('selected', true)]),
        node(73, 72, 'StaticText', contents('carol@example.com')),
        node(74, 71, 'checkbox', labelled('Pick all')),
        // A combobox that shows its value as text, and a combobox named from its contents.
        node(80, 1, 'combobox', labelled('Team'), [prop('expanded', false)]),
        node(81, 80, 'StaticText', contents('dave@example.com')),
        node(82, 1, 'combobox', contents('erin@example.com')),
        // A spin button and a progress bar that are not editable.
        node(90, 1, 'cell', contents('417')),
        node(91, 90, 'spinbutton', labelled('Count')),
        node(92, 1, 'cell', contents('417')),
        node(93, 92, 'progressbar', labelled('Upload')),
        // A button away from any control keeps a name from its contents.
        node(99, 1, 'button', contents('Save')),
      ],
    };
    const read = axTreeFromCdp(VALUES);
    const nameOf = (nodeId: number): string | null | undefined => read.nodes.find((entry) => entry.nodeId === nodeId)?.name;

    const shownOf = (nodeId: number): boolean | undefined => read.nodes.find((entry) => entry.nodeId === nodeId)?.nameMayShowValue;
    const MAY_SHOW = [50, 51, 60, 63, 70, 72, 73, 81, 82, 90, 92];

    it('keeps the browser name for the comparison, and marks each name that may show the value', () => {
      const raw = new Map(VALUES.nodes.map((entry) => [Number((entry as { nodeId: string }).nodeId), entry]));
      for (const nodeId of MAY_SHOW) {
        expect({ nodeId, name: nameOf(nodeId), shown: shownOf(nodeId) }).toEqual({
          nodeId,
          name: (raw.get(nodeId) as { name: { value: string } }).name.value,
          shown: true,
        });
      }
    });

    it('keeps each control, its own name, and the nodes under it with their states', () => {
      for (const nodeId of [52, 61, 71, 74, 80, 91, 93, 99]) expect({ nodeId, shown: shownOf(nodeId) }).toEqual({ nodeId, shown: undefined });
      expect(nameOf(52)).toBe('Age');
      expect(nameOf(61)).toBe('Owner');
      expect(nameOf(71)).toBe('Owners');
      expect(nameOf(74)).toBe('Pick all');
      expect(nameOf(80)).toBe('Team');
      expect(nameOf(91)).toBe('Count');
      expect(nameOf(93)).toBe('Upload');
      expect(nameOf(99)).toBe('Save');
      expect(read.nodes.find((entry) => entry.nodeId === 63)).toMatchObject({ role: 'option', parentId: 62, states: { selected: 'true' } });
      expect(read.nodes.find((entry) => entry.nodeId === 72)).toMatchObject({ role: 'option', parentId: 71, states: { selected: 'true' } });
    });
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

  describe('with a call that never returns', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // Each call races a timer that ends at the start of the read plus the budget. A call that never
    // returns cannot hold the scan: the timer wins and the read is over budget at once.
    async function readWith(send: (method: string) => Promise<unknown>): Promise<unknown> {
      vi.useFakeTimers();
      let result: unknown = 'still waiting';
      void readFullAxTree(send).then((read) => {
        result = read;
      });
      await vi.advanceTimersByTimeAsync(AX_TREE_TIME_BUDGET_MS + 1);
      return result;
    }

    it('is over budget when the tree read itself never returns', async () => {
      expect(await readWith(() => new Promise(() => undefined))).toEqual({ kind: 'over-budget', limit: 'time' });
    });

    it('is over budget when a sort read never returns', async () => {
      const send = (method: string): Promise<unknown> =>
        method === 'Accessibility.getFullAXTree' ? Promise.resolve(header) : new Promise(() => undefined);
      expect(await readWith(send)).toEqual({ kind: 'over-budget', limit: 'time' });
    });
  });

  it('holds exactly the budget the ground truth states', () => {
    expect(AX_TREE_TIME_BUDGET_MS).toBe(500);
    expect(AX_TREE_NODE_BUDGET).toBe(5000);
  });
});

describe('readDesignAxTree', () => {
  const header = {
    nodes: [
      { nodeId: '1', backendDOMNodeId: 1, ignored: false, role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['2'] },
      { nodeId: '2', backendDOMNodeId: 2, ignored: false, role: { value: 'columnheader' }, name: { value: 'Name' }, parentId: '1', childIds: [] },
    ],
  };
  const sized = (count: number): unknown => ({
    nodes: Array.from({ length: count }, (_, index) => ({ nodeId: String(index + 1), backendDOMNodeId: index + 1, ignored: false })),
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('makes one tree call and no header reads, and keeps the nodes and names the browser gives', async () => {
    const calls: string[] = [];
    const read = await readDesignAxTree(async (method) => {
      calls.push(method);
      return RAW;
    });
    expect(calls).toEqual(['Accessibility.getFullAXTree']);
    expect(read).toEqual({ kind: 'tree', nodes: axTreeFromCdp(RAW, { browserNames: true }).nodes });
    // The design checks only count these nodes and never show their names, so the nodes inside a
    // field are kept, where the silent change read leaves them out.
    if (read.kind !== 'tree') throw new Error('not a tree');
    expect(read.nodes.map((node) => node.nodeId)).toEqual([1, 2, 3, 4, 6, 7, 8, 9]);
    expect(read.nodes.find((node) => node.nodeId === 8)).toMatchObject({ parentId: 7, name: 'alice@example.com' });
  });

  it('keeps a name the silent change read marks or leaves out, so a second element with the name is counted', async () => {
    // A button named from its contents, which hold an empty field or an empty progress bar. The
    // browser name is the design's name.
    const SECOND = {
      nodes: [
        { nodeId: '1', backendDOMNodeId: 1, ignored: false, role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['2', '4'] },
        { nodeId: '2', backendDOMNodeId: 2, ignored: false, role: { value: 'button' }, name: { value: 'Refresh', sources: [{ type: 'contents', value: { value: 'Refresh' } }] }, parentId: '1', childIds: ['3'] },
        { nodeId: '3', backendDOMNodeId: 3, ignored: false, role: { value: 'textbox' }, name: { value: 'n' }, parentId: '2', childIds: [], properties: [prop('editable', 'richtext', 'token')] },
        { nodeId: '4', backendDOMNodeId: 4, ignored: false, role: { value: 'button' }, name: { value: 'Refresh', sources: [{ type: 'contents', value: { value: 'Refresh' } }] }, parentId: '1', childIds: ['5'] },
        { nodeId: '5', backendDOMNodeId: 5, ignored: false, role: { value: 'progressbar' }, name: { value: '' }, parentId: '4', childIds: [] },
      ],
    };
    const design = await readDesignAxTree(async () => SECOND);
    if (design.kind !== 'tree') throw new Error('not a tree');
    expect(design.nodes.filter((node) => node.name === 'Refresh').map((node) => node.nodeId)).toEqual([2, 4]);
    expect(design.nodes.some((node) => node.nameMayShowValue !== undefined)).toBe(false);
    const full = await readFullAxTree(async () => SECOND);
    if (full.kind !== 'tree') throw new Error('not a tree');
    expect(full.nodes.find((node) => node.nodeId === 2)?.name).toBeNull();
    expect(full.nodes.find((node) => node.nodeId === 4)).toMatchObject({ name: 'Refresh', nameMayShowValue: true });
  });

  it('gives the same result on a slow machine and a fast one, because no clock takes part', async () => {
    const now = vi.spyOn(Date, 'now');
    const fast = await readDesignAxTree(async () => header);
    // Checked before fake timers start, because starting them reads the clock.
    expect(now).not.toHaveBeenCalled();
    vi.useFakeTimers();
    // On the slow machine a minute passes while the browser builds the tree. A timer in the read
    // would fire inside that minute.
    const slow = await readDesignAxTree(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      return header;
    });
    expect(slow).toEqual(fast);
    expect(fast.kind).toBe('tree');
  });

  it('reads an answer with no list of nodes as unreadable, never as a tree with no nodes', async () => {
    for (const answer of [{}, { nodes: 'x' }, { nodes: { length: 1 } }, null, 'tree']) {
      expect({ answer, read: await readDesignAxTree(async () => answer) }).toEqual({ answer, read: { kind: 'unreadable' } });
    }
    // An empty list is a real answer: a tree with no nodes.
    expect(await readDesignAxTree(async () => ({ nodes: [] }))).toEqual({ kind: 'tree', nodes: [] });
  });

  it(`reads a tree of exactly ${DESIGN_AX_TREE_NODE_LIMIT} nodes`, async () => {
    expect((await readDesignAxTree(async () => sized(DESIGN_AX_TREE_NODE_LIMIT))).kind).toBe('tree');
  });

  it(`is over the limit past ${DESIGN_AX_TREE_NODE_LIMIT} nodes, and says the limit`, async () => {
    expect(await readDesignAxTree(async () => sized(DESIGN_AX_TREE_NODE_LIMIT + 1))).toEqual({
      kind: 'over-limit',
      limit: DESIGN_AX_TREE_NODE_LIMIT,
    });
  });

  it('holds exactly the limit the ground truth states', () => {
    expect(DESIGN_AX_TREE_NODE_LIMIT).toBe(20000);
  });
});

describe('a fake page', () => {
  it('has an empty tree that never changes and no focused node, unless a test scripts them', async () => {
    const page = makeFakePage();
    expect(await page.fullAxTree()).toEqual({ kind: 'tree', documentNodeId: null, nodes: [] });
    expect(await page.designAxTree()).toEqual({ kind: 'tree', nodes: [] });
    expect(await page.focusedNodeId()).toBeNull();
  });

  it('cannot resolve the control a click step names, because it has no DOM', async () => {
    expect(await makeFakePage().controlNodeId('#save')).toBeNull();
  });
});
