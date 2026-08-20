/**
 * Static repeated-toolbar naming check for PatternFly layouts.
 * This unit must never fail a single unnamed toolbar. Ambiguity starts only when toolbars repeat.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { SEL } from './selectors.js';

export async function checkPfToolbarLabeledWhenRepeated(ctx: ProviderContext): Promise<Draft[]> {
  const toolbars = await ctx.page.queryAll(SEL.toolbar);
  if (toolbars.length < 2) {
    return [];
  }

  const drafts: Draft[] = [];
  for (const toolbar of toolbars) {
    const node = await ctx.page.axAt(toolbar.selector);
    const name = node?.name?.trim() ?? '';
    if (name.length > 0) {
      continue;
    }

    drafts.push({
      rule: 'pf-toolbar-labeled-when-repeated',
      layer: 'pf',
      severity: 'moderate',
      evidenceClass: 'deterministic',
      screenId: ctx.screen.id,
      elementPath: toolbar.selector,
      elementName: null,
      role: node?.role ?? null,
      whatUserExperiences: 'Repeated toolbars sound the same, so navigation landmarks are ambiguous.',
      why: 'At least two toolbars are present and one has no accessible name.',
      fix: 'Label each repeated toolbar with a distinct accessible name.',
      evidence: {
        name: { value: node?.name ?? null, source: 'ax-tree', fromTree: true },
        role: { value: node?.role ?? null, source: 'ax-tree', fromTree: true },
      },
      confidence: 'fail',
    });
  }

  return drafts;
}
