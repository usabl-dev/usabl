/**
 * PatternFly rulepack provider for deterministic static checks and interaction probes.
 * This unit must never mint a verdict. It returns Drafts so the gate stays the only authority.
 */
import type { Draft, Provider, ProviderContext } from '../../contracts/index.js';
import { checkPfIconButtonName } from './pf-icon-button-name.js';
import { checkPfKebabExpandedState } from './pf-kebab-expanded-state.js';
import { checkPfRowActionNameUnique } from './pf-row-action-name-unique.js';
import { checkPfTableHeaderAssoc } from './pf-table-header-assoc.js';
import { checkPfToastLiveRegion } from './pf-toast-live-region.js';
import { checkPfToolbarLabeledWhenRepeated } from './pf-toolbar-labeled-when-repeated.js';
import { probeDialogs, probeMenus } from './probes.js';

type RulepackCheck = (ctx: ProviderContext) => Promise<Draft[]>;

const STATIC_CHECKS: RulepackCheck[] = [
  checkPfToastLiveRegion,
  checkPfIconButtonName,
  checkPfKebabExpandedState,
  checkPfTableHeaderAssoc,
  checkPfRowActionNameUnique,
  checkPfToolbarLabeledWhenRepeated,
];

export function makeRulepackProvider(extraChecks: RulepackCheck[] = []): Provider {
  return {
    id: 'pf-rulepack',
    layer: 'pf',
    capabilities: ['live'],
    // The probes below click dialog and menu triggers and press Escape, so any provider that runs
    // after this one reads a page with open, closed, or refocused widgets in it.
    mutatesPageState: true,
    async run(ctx: ProviderContext): Promise<Draft[]> {
      // The PF selectors match nothing on docs, and the PF-worded copy reads wrong for a docs guide.
      // So the whole rulepack is a no-op on docs. App and default behavior stays unchanged.
      if ((ctx.profile ?? 'app') === 'docs') {
        return [];
      }

      const drafts: Draft[] = [];

      // Static checks run first because later interactive probes mutate page state.
      for (const check of STATIC_CHECKS) {
        drafts.push(...(await check(ctx)));
      }
      drafts.push(...(await probeDialogs(ctx)));
      drafts.push(...(await probeMenus(ctx)));
      for (const check of extraChecks) {
        drafts.push(...(await check(ctx)));
      }

      return drafts;
    },
  };
}
