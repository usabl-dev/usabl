/**
 * What changed in the accessibility tree across one action step, outside the control's own change.
 * The silent change rule reads this to tell a step that changed the page from one that did not.
 * Pure: two trees and the acted control in, a summary out. It never reads a value, and it never
 * names a removed node, so a deleted row's text cannot reach evidence through it.
 */
import type { AxTreeNode } from '../contracts/index.js';

/**
 * Counts by role, and the names of added nodes. A count map's keys are sorted, so two equal
 * changes are equal values. addedNames holds each non-empty name once, sorted.
 */
export interface TreeChange {
  added: Record<string, number>;
  removed: Record<string, number>;
  // Nodes whose name or a judged state changed.
  changed: Record<string, number>;
  addedNames: string[];
}

export function isNoChange(change: TreeChange): boolean {
  return Object.keys(change.added).length === 0 && Object.keys(change.removed).length === 0 && Object.keys(change.changed).length === 0;
}

type Tree = ReadonlyMap<number, AxTreeNode>;

function index(nodes: readonly AxTreeNode[]): Tree {
  return new Map(nodes.map((entry) => [entry.nodeId, entry]));
}

function perceived(tree: Tree, nodeId: number): AxTreeNode | undefined {
  const found = tree.get(nodeId);
  return found === undefined || found.ignored ? undefined : found;
}

function sameStates(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

// Every ancestor of a node in one tree, through ignored nodes.
function ancestorsIn(tree: Tree, nodeId: number): number[] {
  const found: number[] = [];
  const seen = new Set<number>([nodeId]);
  for (let parent = tree.get(nodeId)?.parentId ?? null; parent !== null && !seen.has(parent); parent = tree.get(parent)?.parentId ?? null) {
    seen.add(parent);
    found.push(parent);
  }
  return found;
}

// Whether a node is one of the roots or sits under one, in the tree it is read from.
function underAny(tree: Tree, nodeId: number, roots: ReadonlySet<number>): boolean {
  if (roots.has(nodeId)) return true;
  return ancestorsIn(tree, nodeId).some((ancestor) => roots.has(ancestor));
}

function stateChanged(before: Tree, after: Tree, nodeId: number): boolean {
  const old = perceived(before, nodeId);
  const now = perceived(after, nodeId);
  return old !== undefined && now !== undefined && !sameStates(old.states, now.states);
}

function controlsOf(before: Tree, after: Tree, nodeId: number): number[] {
  return [...(before.get(nodeId)?.controls ?? []), ...(after.get(nodeId)?.controls ?? [])];
}

function bump(counts: Map<string, number>, role: string | null): void {
  const key = role ?? 'unknown';
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCounts(counts: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) {
    out[key] = counts.get(key) ?? 0;
  }
  return out;
}

/**
 * The change across one step. A change is a node added or removed, or a name or a judged state
 * that changed, on a node assistive technology perceives in that read. The control's own change is
 * left out: its own states, the states of its ancestors, and, when its own state changed in this
 * step, every node its aria-controls names and everything under those. A tab that becomes
 * selected deselects the tab it replaces, which shares its parent and role, so that tab's state,
 * and the nodes its aria-controls names, are the control's own change too. With no acted control,
 * nothing is left out.
 */
export function compareAxTrees(beforeNodes: readonly AxTreeNode[], afterNodes: readonly AxTreeNode[], acted: number | null): TreeChange {
  const before = index(beforeNodes);
  const after = index(afterNodes);

  // Nodes whose state changes are the control's own.
  const ownStates = new Set<number>();
  // Subtrees whose every change is the control's own.
  const ownSubtrees = new Set<number>();
  if (acted !== null) {
    ownStates.add(acted);
    for (const ancestor of [...ancestorsIn(before, acted), ...ancestorsIn(after, acted)]) {
      ownStates.add(ancestor);
    }
    if (stateChanged(before, after, acted)) {
      for (const controlled of controlsOf(before, after, acted)) ownSubtrees.add(controlled);
      const self = perceived(before, acted);
      const selectedChanged = self !== undefined && perceived(after, acted)?.states.selected !== self.states.selected;
      if (self !== undefined && selectedChanged) {
        for (const sibling of before.values()) {
          if (sibling.nodeId === acted || sibling.ignored || sibling.parentId !== self.parentId || sibling.role !== self.role) continue;
          if (perceived(after, sibling.nodeId)?.states.selected === sibling.states.selected) continue;
          ownStates.add(sibling.nodeId);
          for (const controlled of controlsOf(before, after, sibling.nodeId)) ownSubtrees.add(controlled);
        }
      }
    }
  }
  const ownInBefore = (nodeId: number): boolean => ownSubtrees.size > 0 && underAny(before, nodeId, ownSubtrees);
  const ownInAfter = (nodeId: number): boolean => ownSubtrees.size > 0 && underAny(after, nodeId, ownSubtrees);

  const added = new Map<string, number>();
  const removed = new Map<string, number>();
  const changed = new Map<string, number>();
  const addedNames = new Set<string>();

  for (const now of after.values()) {
    if (now.ignored) continue;
    const old = perceived(before, now.nodeId);
    if (old === undefined) {
      if (ownInAfter(now.nodeId)) continue;
      bump(added, now.role);
      const name = now.name?.trim() ?? '';
      if (name.length > 0) addedNames.add(name);
      continue;
    }
    if (ownInAfter(now.nodeId) || ownInBefore(now.nodeId)) continue;
    const nameChanged = old.name !== now.name;
    const statesChanged = !ownStates.has(now.nodeId) && !sameStates(old.states, now.states);
    if (nameChanged || statesChanged) bump(changed, now.role);
  }
  for (const old of before.values()) {
    if (old.ignored || perceived(after, old.nodeId) !== undefined) continue;
    if (ownInBefore(old.nodeId)) continue;
    bump(removed, old.role);
  }

  return {
    added: sortedCounts(added),
    removed: sortedCounts(removed),
    changed: sortedCounts(changed),
    addedNames: [...addedNames].sort(),
  };
}
