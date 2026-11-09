/**
 * Finds the elements on a page that can carry a catalog defect, with the reads the engine already
 * trusts: Page.queryAll for the selector, Page.axAt for what the accessibility tree says, and
 * Page.hostMarkup for whether the element holds text of its own. It reads only. It never changes
 * the page.
 */
import type { Page } from '../../contracts/index.js';
import type { TargetFinder } from './catalog.js';

export type TargetSearch = { kind: 'found'; paths: string[] } | { kind: 'none'; reason: string };

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

async function treeAgrees(page: Page, path: string, tree: NonNullable<TargetFinder['tree']>): Promise<boolean> {
  const node = await page.axAt(path);
  if (node === null) {
    return false;
  }
  if (tree.roles !== undefined && (node.role === null || !tree.roles.includes(node.role))) {
    return false;
  }
  if (tree.named === true && (node.name ?? '').trim() === '') {
    return false;
  }
  return true;
}

async function textAgrees(page: Page, path: string, text: 'some' | 'none'): Promise<boolean> {
  const markup = await page.hostMarkup(path);
  if (markup === null) {
    return false;
  }
  const has = markup.defaultSlotText.trim() !== '';
  return text === 'some' ? has : !has;
}

export async function findTargets(page: Page, finder: TargetFinder): Promise<TargetSearch> {
  const candidates = (await page.queryAll(finder.selector)).map((ref) => ref.selector);
  const atLeast = finder.atLeast ?? 1;
  if (candidates.length < atLeast) {
    return {
      kind: 'none',
      reason:
        candidates.length === 0
          ? 'no element on the page matches the target selector'
          : `the target selector matches ${count(candidates.length, 'element')}, and the defect needs at least ${atLeast}`,
    };
  }

  const kept: string[] = [];
  for (const path of candidates) {
    if (finder.tree !== undefined && !(await treeAgrees(page, path, finder.tree))) {
      continue;
    }
    if (finder.text !== undefined && !(await textAgrees(page, path, finder.text))) {
      continue;
    }
    kept.push(path);
    if (finder.every !== true) {
      break;
    }
  }

  if (kept.length === 0) {
    return { kind: 'none', reason: 'no element the target selector matches has the tree and text facts the defect needs' };
  }
  if (kept.length < atLeast) {
    return {
      kind: 'none',
      reason: `${count(kept.length, 'element')} on the page can carry the defect, and it needs at least ${atLeast}`,
    };
  }
  return { kind: 'found', paths: kept };
}
