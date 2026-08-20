/**
 * Static duplicate row-action name check for PatternFly tables.
 * This unit must never pass duplicated names as unique because row context is then hidden from speech output.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { SEL } from './selectors.js';

interface NamedAction {
  selector: string;
  name: string;
  role: string | null;
}

export async function checkPfRowActionNameUnique(ctx: ProviderContext): Promise<Draft[]> {
  const actions = await ctx.page.queryAll(SEL.rowActionButton);
  const byName = new Map<string, NamedAction[]>();

  for (const action of actions) {
    const node = await ctx.page.axAt(action.selector);
    const rawName = node?.name ?? '';
    const name = rawName.trim();
    if (name.length === 0) {
      continue;
    }

    const group = byName.get(name);
    const entry: NamedAction = { selector: action.selector, name, role: node?.role ?? null };
    if (group) {
      group.push(entry);
      continue;
    }
    byName.set(name, [entry]);
  }

  const drafts: Draft[] = [];
  // Per-name count comparison is the signal: repeated names across rows lose row identity.
  for (const [name, group] of byName) {
    if (group.length < 2) {
      continue;
    }

    for (const action of group) {
      drafts.push({
        rule: 'pf-row-action-name-unique',
        layer: 'pf',
        severity: 'serious',
        evidenceClass: 'deterministic',
        screenId: ctx.screen.id,
        elementPath: action.selector,
        elementName: action.name,
        role: action.role,
        whatUserExperiences: 'Multiple row actions announce the same name, so destination row is unclear.',
        why: `The accessible action name "${name}" is reused in more than one table row.`,
        fix: 'Include row context in each action name, such as the row item name.',
        evidence: {
          name: { value: action.name, source: 'ax-tree', fromTree: true },
          role: { value: action.role, source: 'ax-tree', fromTree: true },
          extra: { duplicateName: name, duplicateCount: group.length },
        },
        confidence: 'fail',
      });
    }
  }

  return drafts;
}
