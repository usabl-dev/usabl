/**
 * Static icon button naming check for PatternFly controls.
 * This unit must never infer a name from markup. It trusts only the accessibility tree.
 */
import type { Draft, ProviderContext } from '../../contracts/index.js';
import { SEL } from './selectors.js';

export async function checkPfIconButtonName(ctx: ProviderContext): Promise<Draft[]> {
  const candidates = await ctx.page.queryAll(SEL.unnamedButton);
  const drafts: Draft[] = [];

  for (const candidate of candidates) {
    const node = await ctx.page.axAt(candidate.selector);
    if (node?.name) {
      continue;
    }

    drafts.push({
      rule: 'pf-icon-button-name',
      layer: 'pf',
      severity: 'serious',
      evidenceClass: 'deterministic',
      screenId: ctx.screen.id,
      elementPath: candidate.selector,
      elementName: null,
      role: node?.role ?? null,
      whatUserExperiences: 'A button action is announced without a usable name.',
      why: 'The accessibility tree reports an empty button name.',
      fix: 'Add visible text, aria-label, or aria-labelledby so the button has a stable name.',
      evidence: {
        name: { value: node?.name ?? null, source: 'ax-tree', fromTree: true },
        role: { value: node?.role ?? null, source: 'ax-tree', fromTree: true },
      },
      confidence: 'fail',
    });
  }

  return drafts;
}
