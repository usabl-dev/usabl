/**
 * Compares axe run in the page's own world with axe run in usabl's isolated world, on one page.
 *
 * The page-world run is the one @axe-core/playwright makes, which is how usabl ran axe before it
 * moved axe into an isolated world. The isolated run is runAxeInIsolatedWorld. Both are reduced to
 * the facts a finding is made of and compared as multisets: for each element axe reported, the
 * result category (violation, incomplete, pass), the rule id, the target selector, the impact, and,
 * for violations and incomplete results, the usabl identity key the gate would compute. Rules axe
 * found inapplicable are compared by id.
 *
 * Test-only. Nothing here ships in the package.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page as PwPage } from 'playwright';
import type { Page as UsablPage } from '../../src/contracts/index.js';
import { runAxeInIsolatedWorld, type UncheckedFrame } from '../../src/deps/axe-world.js';
import { adoptPage, mapAxeResults } from '../../src/deps/real.js';
import { computeIdentity } from '../../src/primitives/identity.js';
import { axeProvider, type AxeRunResult } from '../../src/providers/axe/index.js';
import { attachRowScopeToDrafts } from '../../src/providers/row-scope.js';
import { testConfig } from '../helpers.js';

export type Category = 'violation' | 'incomplete' | 'pass' | 'inapplicable';

/** One element axe reported under one rule, or one rule axe found inapplicable. */
export interface Entry {
  category: Category;
  rule: string;
  target: string | null;
  impact: string | null;
  elementKey: string | null;
}

export interface WorldRun {
  entries: Entry[];
  uncheckedFrames: UncheckedFrame[];
}

export interface Difference {
  entry: Entry;
  pageWorld: number;
  isolated: number;
}

export interface Comparison {
  pageWorld: WorldRun;
  isolated: WorldRun;
  differences: Difference[];
  counts: Record<Category, number>;
  // Set when a difference was found and a second page-world run disagreed with the first, so the
  // page changed by itself between runs and the difference says nothing about the two worlds.
  unstable: boolean;
}

const SCREEN = { id: 'compare', url: 'about:blank' };

function rawEntries(raw: unknown): Array<Omit<Entry, 'elementKey'>> {
  const out: Array<Omit<Entry, 'elementKey'>> = [];
  const buckets: Array<[string, Category]> = [
    ['violations', 'violation'],
    ['incomplete', 'incomplete'],
    ['passes', 'pass'],
  ];
  const record = raw as Record<string, unknown> | null;
  for (const [bucket, category] of buckets) {
    const issues = record?.[bucket];
    if (!Array.isArray(issues)) continue;
    for (const issue of issues as Array<{ id: string; impact?: string | null; nodes?: Array<{ target: unknown }> }>) {
      for (const node of issue.nodes ?? []) {
        out.push({
          category,
          rule: issue.id,
          target: JSON.stringify(node.target),
          // A passing node carries no impact in axe's report, so it is not compared.
          impact: category === 'pass' ? null : (issue.impact ?? null),
        });
      }
    }
  }
  const inapplicable = record?.['inapplicable'];
  if (Array.isArray(inapplicable)) {
    for (const rule of inapplicable as Array<{ id: string }>) {
      out.push({ category: 'inapplicable', rule: rule.id, target: null, impact: null });
    }
  }
  return out;
}

/**
 * The identity key of each violation and incomplete node, in report order: violations first, then
 * incomplete, each in axe's issue and node order, which is the order the axe provider maps them in.
 */
async function elementKeys(usabl: UsablPage, mapped: AxeRunResult): Promise<Array<string | null>> {
  const page = { ...usabl, runAxe: async () => mapped } as UsablPage;
  const output = await axeProvider.run({ page, screen: SCREEN, config: testConfig() });
  const drafts = Array.isArray(output) ? output : output.drafts;
  const rows = await attachRowScopeToDrafts(usabl, SCREEN, drafts);
  return rows.drafts.map((draft) => computeIdentity(draft).elementKey);
}

async function withKeys(usabl: UsablPage | null, raw: unknown): Promise<Entry[]> {
  const entries = rawEntries(raw);
  const keys = usabl === null ? [] : await elementKeys(usabl, mapAxeResults(raw));
  let index = 0;
  return entries.map((entry) => {
    if (entry.category === 'violation' || entry.category === 'incomplete') {
      const key = usabl === null ? null : (keys[index] ?? '(missing)');
      index += 1;
      return { ...entry, elementKey: key };
    }
    return { ...entry, elementKey: null };
  });
}

function runOptionsFor(tags?: readonly string[]): Record<string, unknown> {
  return tags !== undefined && tags.length > 0 ? { runOnly: { type: 'tag', values: [...tags] } } : {};
}

/** axe in the page's own world, the way usabl ran it before. */
export async function pageWorldRaw(pw: PwPage, tags?: readonly string[]): Promise<unknown> {
  const builder = new AxeBuilder({ page: pw });
  return tags !== undefined && tags.length > 0 ? builder.withTags([...tags]).analyze() : builder.analyze();
}

/** axe in usabl's isolated world, through a CDP session of its own. */
export async function isolatedRaw(
  pw: PwPage,
  tags?: readonly string[],
): Promise<{ results: unknown; uncheckedFrames: UncheckedFrame[] }> {
  const cdp = await pw.context().newCDPSession(pw);
  try {
    return await runAxeInIsolatedWorld(pw, cdp, runOptionsFor(tags));
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

function serialize(entry: Entry): string {
  return JSON.stringify([entry.category, entry.rule, entry.target, entry.impact, entry.elementKey]);
}

/** The entries whose count differs between the two runs, in a stable order. */
export function diffEntries(a: Entry[], b: Entry[]): Difference[] {
  const counts = new Map<string, { entry: Entry; a: number; b: number }>();
  for (const entry of a) {
    const key = serialize(entry);
    const slot = counts.get(key) ?? { entry, a: 0, b: 0 };
    slot.a += 1;
    counts.set(key, slot);
  }
  for (const entry of b) {
    const key = serialize(entry);
    const slot = counts.get(key) ?? { entry, a: 0, b: 0 };
    slot.b += 1;
    counts.set(key, slot);
  }
  return [...counts.entries()]
    .filter(([, slot]) => slot.a !== slot.b)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([, slot]) => ({ entry: slot.entry, pageWorld: slot.a, isolated: slot.b }));
}

function countByCategory(entries: Entry[]): Record<Category, number> {
  const counts: Record<Category, number> = { violation: 0, incomplete: 0, pass: 0, inapplicable: 0 };
  for (const entry of entries) counts[entry.category] += 1;
  return counts;
}

export interface CompareOptions {
  tags?: readonly string[];
  // Compute identity keys. It adopts the page for the row read, which the sweep may skip.
  keys?: boolean;
}

/**
 * Compares a page-world result and an isolated result taken from the page as it stands. A
 * difference is confirmed by running the page world again: if the page world disagrees with
 * itself, the page moved between runs and the comparison is marked unstable.
 */
export async function compareRaw(
  pw: PwPage,
  pageRaw: unknown,
  isolated: { results: unknown; uncheckedFrames: UncheckedFrame[] },
  options: CompareOptions = {},
): Promise<Comparison> {
  const usabl = options.keys === false ? null : await adoptPage(pw);
  try {
    const pageEntries = await withKeys(usabl, pageRaw);
    const isolatedEntries = await withKeys(usabl, isolated.results);
    const differences = diffEntries(pageEntries, isolatedEntries);
    let unstable = false;
    if (differences.length > 0) {
      const again = await withKeys(usabl, await pageWorldRaw(pw, options.tags));
      unstable = diffEntries(pageEntries, again).length > 0;
    }
    return {
      pageWorld: { entries: pageEntries, uncheckedFrames: [] },
      isolated: { entries: isolatedEntries, uncheckedFrames: isolated.uncheckedFrames },
      differences,
      counts: countByCategory(pageEntries),
      unstable,
    };
  } finally {
    await usabl?.close();
  }
}

/**
 * Runs axe both ways on the page as it stands and compares. Nothing changes the page between the
 * runs, so a page that does not change by itself gives both runs the same DOM.
 */
export async function compareAxeWorlds(pw: PwPage, options: CompareOptions = {}): Promise<Comparison> {
  const pageRaw = await pageWorldRaw(pw, options.tags);
  const isolated = await isolatedRaw(pw, options.tags);
  return compareRaw(pw, pageRaw, isolated, options);
}

/** The tags a set of axe run options names, or none. */
export function tagsOf(runOptions: unknown): string[] | undefined {
  const runOnly = (runOptions as { runOnly?: { type?: string; values?: unknown } } | null)?.runOnly;
  if (runOnly?.type !== 'tag' || !Array.isArray(runOnly.values)) return undefined;
  return runOnly.values.filter((value): value is string => typeof value === 'string');
}

/** The run options a set of tags means, the way usabl builds them. */
export { runOptionsFor };
