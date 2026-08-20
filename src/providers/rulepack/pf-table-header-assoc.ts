/**
 * Static table header association check for PatternFly tables.
 * This unit must never treat missing scope and id as covered because they are easy to inspect.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { SEL } from './selectors.js';

export async function checkPfTableHeaderAssoc(ctx: ProviderContext): Promise<Draft[]> {
  const headers = await ctx.page.queryAll(SEL.unscopedTh);
  const drafts: Draft[] = [];

  for (const header of headers) {
    const node = await ctx.page.axAt(header.selector);
    drafts.push({
      rule: 'pf-table-header-assoc',
      layer: 'pf',
      severity: 'serious',
      evidenceClass: 'deterministic',
      screenId: ctx.screen.id,
      elementPath: header.selector,
      elementName: node?.name ?? null,
      role: node?.role ?? null,
      whatUserExperiences: 'Table headers are ambiguous, so row and column context can be lost.',
      why: 'The header has neither scope nor id to bind cells to a named header.',
      fix: 'Set scope on header cells, or provide ids that data cells reference.',
      evidence: {
        name: { value: node?.name ?? null, source: 'ax-tree', fromTree: true },
        role: { value: node?.role ?? null, source: 'ax-tree', fromTree: true },
      },
      confidence: 'fail',
    });
  }

  return drafts;
}
