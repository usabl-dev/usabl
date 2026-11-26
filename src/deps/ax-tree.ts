/**
 * Reads the whole accessibility tree of the main frame over CDP, for the silent change rule and
 * for the design checks. The browser computes the tree from the flat tree, so open shadow roots
 * are in it and no page script world takes part. This unit keeps only what a change is judged on.
 * It never reads a value, and a read past its budget is reported as over budget, never as a tree.
 * The design checks read the same tree with a node limit and no time budget.
 */
import type { AxTreeNode, AxTreeRead, DesignAxTreeRead } from '../contracts/index.js';

/** The most time one tree read may take, the sort reads included, before it is not a tree. */
export const AX_TREE_TIME_BUDGET_MS = 500;
/** The most nodes one tree read may return before it is not a tree. */
export const AX_TREE_NODE_BUDGET = 5000;

/** Sends one CDP command and returns its result. */
export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

// The states a change is judged on, by their CDP property names. Sort is read separately, because
// the browser does not expose aria-sort as a property.
const JUDGED_STATES: ReadonlySet<string> = new Set(['checked', 'expanded', 'pressed', 'selected', 'invalid']);
// The roles that carry a sort state.
const HEADER_ROLES: ReadonlySet<string> = new Set(['columnheader', 'rowheader']);
const SORT_TOKENS: ReadonlySet<string> = new Set(['ascending', 'descending', 'other', 'none']);
// The roles of controls that hold a value without being editable: a range, or a choice among
// options. The browser puts that value into a name built from contents, and an option's name is
// the text a person may have chosen.
const VALUE_ROLES: ReadonlySet<string> = new Set(['combobox', 'listbox', 'slider', 'spinbutton', 'progressbar', 'meter', 'scrollbar']);

function getProp(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  return Reflect.get(value, key);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function properties(raw: unknown): unknown[] {
  const list = getProp(raw, 'properties');
  return Array.isArray(list) ? list : [];
}

function hasProperty(raw: unknown, name: string): boolean {
  return properties(raw).some((property) => getProp(property, 'name') === name);
}

function roleOf(raw: unknown): string | null {
  return readString(getProp(getProp(raw, 'role'), 'value'));
}

function isValueControl(raw: unknown): boolean {
  const role = roleOf(raw);
  return role !== null && VALUE_ROLES.has(role);
}

// A busy value is true, or 1 as Chromium reports it for aria-busy="true".
function isTrue(value: unknown): boolean {
  return value === true || value === 1 || value === 'true';
}

// Whether a name may hold the value of a field or a control the node holds. The browser lists
// where a name comes from, and the first source with a value that is not superseded is the one it
// used. A name built from the node's contents includes that value. A name that does not say where
// it comes from may too. An author-given name, such as aria-label, does not.
function nameMayHoldValue(rawName: unknown): boolean {
  const sources = getProp(rawName, 'sources');
  if (!Array.isArray(sources)) {
    return true;
  }
  const used = usedSource(sources);
  return used === undefined || getProp(used, 'type') === 'contents';
}

function usedSource(sources: unknown[]): unknown {
  return sources.find((source) => getProp(source, 'value') !== undefined && getProp(source, 'superseded') !== true);
}

// The DOM nodes a name built from other elements, through aria-labelledby or a label element,
// was built from. Empty for any other name.
function relatedNodeIds(rawName: unknown): number[] {
  const sources = getProp(rawName, 'sources');
  const used = Array.isArray(sources) ? usedSource(sources) : undefined;
  if (used === undefined || getProp(used, 'type') !== 'relatedElement') {
    return [];
  }
  const ids: number[] = [];
  for (const holder of [getProp(used, 'attributeValue'), getProp(used, 'nativeSourceValue')]) {
    const related = getProp(holder, 'relatedNodes');
    if (!Array.isArray(related)) {
      continue;
    }
    for (const entry of related) {
      const id = readNumber(getProp(entry, 'backendDOMNodeId'));
      if (id !== null) {
        ids.push(id);
      }
    }
  }
  return ids;
}

export interface AxTreeOptions {
  // Keep every node and every name as the browser gives them, with no field rule and no value mark.
  // For the design checks, which only count names and never show them.
  browserNames?: boolean;
}

/**
 * The tree a getFullAXTree result describes. A node with no DOM node, such as an inline text box,
 * has no identity across two reads, so it is left out, and its children climb to the nearest
 * ancestor that has one. The content of an editable field is left out too: the text inside a
 * text box is its value, and a value is never read. The field itself is kept, with its name and
 * states. A node that holds a field, such as a row or a button with a text box inside, has no name
 * when the browser built its name from its contents or does not say where the name comes from,
 * because that name can hold the field's value. An ignored node is kept without a name, so the
 * parent chain stays whole.
 *
 * A control with a value that is not editable, such as a slider, a spin button, a progress bar, a
 * select, or a list box, keeps every name the browser gives, because the silent change rule compares
 * them. A name that may show its value is marked instead, and evidence never shows a marked name:
 * a name built from contents that hold such a control, the control's own name when it is built from
 * its contents, the name of a node inside it built from contents, the name of an option inside
 * it, whatever its source, and a name built through aria-labelledby or a label element from such
 * a control, from a node inside one, or from a node that holds one.
 *
 * With `browserNames`, every node with a DOM node is kept, the content of a field included, and
 * every name is the browser's own, so a second element with a design's name is always counted.
 */
export function axTreeFromCdp(result: unknown, options: AxTreeOptions = {}): { documentNodeId: number | null; nodes: AxTreeNode[] } {
  const browserNames = options.browserNames === true;
  const rawNodes = getProp(result, 'nodes');
  if (!Array.isArray(rawNodes)) {
    return { documentNodeId: null, nodes: [] };
  }
  const byAxId = new Map<string, unknown>();
  for (const raw of rawNodes) {
    const axId = readString(getProp(raw, 'nodeId'));
    if (axId !== null) {
      byAxId.set(axId, raw);
    }
  }
  const parentOf = (raw: unknown): unknown => {
    const parentAxId = readString(getProp(raw, 'parentId'));
    return parentAxId === null ? undefined : byAxId.get(parentAxId);
  };
  // Every ancestor of a node that matches, that is not editable itself. A field is the parent of its
  // own inner editor, and the field keeps its own name.
  const holding = (matches: (raw: unknown) => boolean): Set<unknown> => {
    const holders = new Set<unknown>();
    for (const raw of rawNodes) {
      if (!matches(raw)) {
        continue;
      }
      const seen = new Set<unknown>();
      for (let ancestor = parentOf(raw); ancestor !== undefined && !seen.has(ancestor); ancestor = parentOf(ancestor)) {
        seen.add(ancestor);
        if (!hasProperty(ancestor, 'editable')) {
          holders.add(ancestor);
        }
      }
    }
    return holders;
  };
  const holdsField = browserNames ? new Set<unknown>() : holding((raw) => hasProperty(raw, 'editable'));
  const holdsValueControl = browserNames ? new Set<unknown>() : holding(isValueControl);
  const byDomId = new Map<number, unknown>();
  for (const raw of rawNodes) {
    const domId = readNumber(getProp(raw, 'backendDOMNodeId'));
    if (domId !== null && !byDomId.has(domId)) {
      byDomId.set(domId, raw);
    }
  }
  const hasValueControlAncestor = (raw: unknown): boolean => {
    const seen = new Set<unknown>();
    for (let ancestor = parentOf(raw); ancestor !== undefined && !seen.has(ancestor); ancestor = parentOf(ancestor)) {
      seen.add(ancestor);
      if (isValueControl(ancestor)) {
        return true;
      }
    }
    return false;
  };
  // A name built from other elements takes their values too: a select gives its chosen option, a
  // slider its value. So it may show a value when one of them is a value control, is inside one, or
  // holds one.
  const builtFromValue = (rawName: unknown): boolean =>
    relatedNodeIds(rawName).some((id) => {
      const related = byDomId.get(id);
      return related !== undefined && (isValueControl(related) || holdsValueControl.has(related) || hasValueControlAncestor(related));
    });

  let documentNodeId: number | null = null;
  const nodes: AxTreeNode[] = [];
  for (const raw of rawNodes) {
    const nodeId = readNumber(getProp(raw, 'backendDOMNodeId'));
    if (nodeId === null) {
      continue;
    }
    // The nearest ancestor with a DOM node is the parent. Any editable ancestor means this node is
    // inside a field, and its text is the field's value.
    let parentId: number | null = null;
    let insideField = false;
    let insideValueControl = false;
    const seen = new Set<unknown>();
    for (let ancestor = parentOf(raw); ancestor !== undefined && !seen.has(ancestor); ancestor = parentOf(ancestor)) {
      seen.add(ancestor);
      if (!browserNames && hasProperty(ancestor, 'editable')) {
        insideField = true;
        break;
      }
      if (isValueControl(ancestor)) {
        insideValueControl = true;
      }
      if (parentId === null) {
        parentId = readNumber(getProp(ancestor, 'backendDOMNodeId'));
      }
    }
    if (insideField) {
      continue;
    }
    const role = roleOf(raw);
    const ignored = getProp(raw, 'ignored') === true;
    const rawName = getProp(raw, 'name');
    const name = ignored || (holdsField.has(raw) && nameMayHoldValue(rawName)) ? null : readString(getProp(rawName, 'value'));
    const fromContents = nameMayHoldValue(rawName);
    const mayShowValue =
      !browserNames &&
      name !== null &&
      (((holdsValueControl.has(raw) || isValueControl(raw) || insideValueControl) && fromContents) ||
        (insideValueControl && role === 'option') ||
        builtFromValue(rawName));
    if (role === 'RootWebArea' && documentNodeId === null) {
      documentNodeId = nodeId;
    }

    const states: Record<string, string> = {};
    let busy = false;
    const controls: number[] = [];
    for (const property of properties(raw)) {
      const name = readString(getProp(property, 'name'));
      const value = getProp(property, 'value');
      if (name === null) {
        continue;
      }
      if (JUDGED_STATES.has(name)) {
        const state = getProp(value, 'value');
        if (state !== undefined && state !== null) {
          states[name] = String(state);
        }
      } else if (name === 'busy') {
        busy = isTrue(getProp(value, 'value'));
      } else if (name === 'controls') {
        const related = getProp(value, 'relatedNodes');
        if (Array.isArray(related)) {
          for (const entry of related) {
            const id = readNumber(getProp(entry, 'backendDOMNodeId'));
            if (id !== null) {
              controls.push(id);
            }
          }
        }
      }
    }

    nodes.push({
      nodeId,
      parentId,
      role,
      name,
      ignored,
      states: ignored ? {} : states,
      busy: !ignored && busy,
      controls: ignored ? [] : controls,
      ...(mayShowValue ? { nameMayShowValue: true as const } : {}),
    });
  }
  return { documentNodeId, nodes };
}

/**
 * The sort state aria-sort gives, from a CDP attribute list (name, value, name, value). A known
 * token in any case is that token, any other value is none, as the browser computes it, and no
 * attribute is null.
 */
export function sortStateFrom(attributes: unknown): string | null {
  if (!Array.isArray(attributes)) {
    return null;
  }
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (attributes[index] === 'aria-sort') {
      const token = String(attributes[index + 1]).trim().toLowerCase();
      return SORT_TOKENS.has(token) ? token : 'none';
    }
  }
  return null;
}

// What a call gives when its timer ends first.
const OUT_OF_TIME: unique symbol = Symbol('out of time');

/**
 * One read of the whole tree, with the sort state of every header. The budget covers the whole
 * read, so a table with many headers cannot stretch it. Each call races a timer that ends at the
 * start of the read plus the budget, so a call that is slow or never returns cannot hold the scan:
 * when the timer wins, the read is over budget at once.
 */
export async function readFullAxTree(send: CdpSend, now: () => number = Date.now): Promise<AxTreeRead> {
  const start = now();
  const deadline = start + AX_TREE_TIME_BUDGET_MS;
  const overTime = (): boolean => now() - start > AX_TREE_TIME_BUDGET_MS;
  const timed = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const call = send(method, params);
    // A call that loses the race may still fail later. Nothing waits for it then.
    call.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeUp = new Promise<typeof OUT_OF_TIME>((resolve) => {
      timer = setTimeout(() => resolve(OUT_OF_TIME), Math.max(0, deadline - now()));
    });
    try {
      return await Promise.race([call, timeUp]);
    } finally {
      clearTimeout(timer);
    }
  };
  const overBudgetTime: AxTreeRead = { kind: 'over-budget', limit: 'time' };

  const result = await timed('Accessibility.getFullAXTree');
  if (result === OUT_OF_TIME) {
    return overBudgetTime;
  }
  const rawNodes = getProp(result, 'nodes');
  if (Array.isArray(rawNodes) && rawNodes.length > AX_TREE_NODE_BUDGET) {
    return { kind: 'over-budget', limit: 'nodes' };
  }
  if (overTime()) {
    return overBudgetTime;
  }
  const tree = axTreeFromCdp(result);
  for (const node of tree.nodes) {
    if (node.ignored || node.role === null || !HEADER_ROLES.has(node.role)) {
      continue;
    }
    const described = await timed('DOM.describeNode', { backendNodeId: node.nodeId });
    if (described === OUT_OF_TIME || overTime()) {
      return overBudgetTime;
    }
    const sort = sortStateFrom(getProp(getProp(described, 'node'), 'attributes'));
    if (sort !== null) {
      node.states.sort = sort;
    }
  }
  return { kind: 'tree', documentNodeId: tree.documentNodeId, nodes: tree.nodes };
}

/**
 * The most nodes the browser may return for one design check read before it is not a tree.
 * Measured in Chromium, the largest fixture page returns 172 nodes and the app screens measured for
 * the silent change rule return 179 to 300. The limit is far above both, so a long real page is
 * still read, and it still bounds the work of one read.
 */
export const DESIGN_AX_TREE_NODE_LIMIT = 20000;

/**
 * One read of the whole tree for the design checks. A design check decides a gate input, so no
 * clock may decide it: there is no timer and no time budget, only a node count. It reads no sort
 * state, which no design check uses, so it makes exactly one browser call. It keeps every node and
 * every name as the browser gives them: the design checks count elements by role and name, and a
 * name left out would let a second element with the design's name drop out of the count. No name
 * from this read reaches a draft.
 */
export async function readDesignAxTree(send: CdpSend): Promise<DesignAxTreeRead> {
  const result = await send('Accessibility.getFullAXTree');
  const rawNodes = getProp(result, 'nodes');
  // An answer with no list of nodes is not an empty tree. Read as one, it would let a name check
  // report a missing element on a page it never read.
  if (!Array.isArray(rawNodes)) {
    return { kind: 'unreadable' };
  }
  if (rawNodes.length > DESIGN_AX_TREE_NODE_LIMIT) {
    return { kind: 'over-limit', limit: DESIGN_AX_TREE_NODE_LIMIT };
  }
  return { kind: 'tree', nodes: axTreeFromCdp(result, { browserNames: true }).nodes };
}
