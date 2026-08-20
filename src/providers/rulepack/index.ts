/**
 * PatternFly rulepack provider for deterministic static checks.
 * This unit must never mint a verdict. It returns Drafts so the gate stays the only authority.
 */
import type { Draft, Provider, ProviderContext } from '../../contracts/index.js';
import { checkPfIconButtonName } from './pf-icon-button-name.js';
import { checkPfKebabExpandedState } from './pf-kebab-expanded-state.js';
import { checkPfRowActionNameUnique } from './pf-row-action-name-unique.js';
import { checkPfTableHeaderAssoc } from './pf-table-header-assoc.js';
import { checkPfToastLiveRegion } from './pf-toast-live-region.js';
import { checkPfToolbarLabeledWhenRepeated } from './pf-toolbar-labeled-when-repeated.js';

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
    async run(ctx: ProviderContext): Promise<Draft[]> {
      const drafts: Draft[] = [];

      // Static checks run first because later interactive probes mutate page state.
      for (const check of STATIC_CHECKS) {
        drafts.push(...(await check(ctx)));
      }
      for (const check of extraChecks) {
        drafts.push(...(await check(ctx)));
      }

      return drafts;
    },
  };
}
