/**
 * PatternFly rulepack provider for deterministic static checks and interaction probes.
 * This unit must never mint a verdict. It returns Drafts so the gate stays the only authority.
 */
import type {
  CoverageGap,
  Draft,
  Provider,
  ProviderContext,
  ProviderOutput,
} from '../../contracts/index.js';
import { checkPfIconButtonName } from './pf-icon-button-name.js';
import { checkPfKebabExpandedState } from './pf-kebab-expanded-state.js';
import { checkPfRowActionNameUnique } from './pf-row-action-name-unique.js';
import { checkPfTableHeaderAssoc } from './pf-table-header-assoc.js';
import { checkPfToastLiveRegion } from './pf-toast-live-region.js';
import { checkPfToolbarLabeledWhenRepeated } from './pf-toolbar-labeled-when-repeated.js';
import { probeDialogs, probeMenus } from './probes.js';

type RulepackCheck = (ctx: ProviderContext) => Promise<Draft[]>;

// Each check carries a stable name so a check that throws can be disclosed by name in a gap.
interface NamedCheck {
  name: string;
  run: RulepackCheck;
}

const STATIC_CHECKS: NamedCheck[] = [
  { name: 'pf-toast-live-region', run: checkPfToastLiveRegion },
  { name: 'pf-icon-button-name', run: checkPfIconButtonName },
  { name: 'pf-kebab-expanded-state', run: checkPfKebabExpandedState },
  { name: 'pf-table-header-assoc', run: checkPfTableHeaderAssoc },
  { name: 'pf-row-action-name-unique', run: checkPfRowActionNameUnique },
  { name: 'pf-toolbar-labeled-when-repeated', run: checkPfToolbarLabeledWhenRepeated },
];

// Probes run after the static checks because they click triggers and press keys, so they mutate
// the page. They are named the same way a static check is, so a throwing probe is disclosed too.
const PROBES: NamedCheck[] = [
  { name: 'probe-dialogs', run: probeDialogs },
  { name: 'probe-menus', run: probeMenus },
];

// One check that throws must not drop the whole rulepack's drafts. It becomes a scoped gap that
// names the check and the error, and the remaining checks still run and return their drafts.
function checkGap(name: string, message: string): CoverageGap {
  return {
    ref: `provider:pf-rulepack/${name}`,
    state: 'not-covered',
    reason: `rulepack check ${name} failed: ${message}`,
  };
}

export function makeRulepackProvider(extraChecks: RulepackCheck[] = []): Provider {
  return {
    id: 'pf-rulepack',
    layer: 'pf',
    capabilities: ['live'],
    // The probes below click dialog and menu triggers and press Escape, so any provider that runs
    // after this one reads a page with open, closed, or refocused widgets in it.
    mutatesPageState: true,
    async run(ctx: ProviderContext): Promise<ProviderOutput> {
      // The PF selectors match nothing on docs, and the PF-worded copy reads wrong for a docs guide.
      // So the whole rulepack is a no-op on docs. App and default behavior stays unchanged.
      if ((ctx.profile ?? 'app') === 'docs') {
        return { drafts: [] };
      }

      // Static checks first, then probes, because probes mutate page state. Extra checks name
      // themselves by position so an injected check that throws is still disclosed.
      const named: NamedCheck[] = [
        ...STATIC_CHECKS,
        ...PROBES,
        ...extraChecks.map((run, index) => ({ name: `extra-check-${index + 1}`, run })),
      ];

      const drafts: Draft[] = [];
      const gaps: CoverageGap[] = [];

      // Each check runs inside its own try/catch, so one check that throws is scoped to a disclosed
      // gap and the checks after it still run. Silence is not evidence, so the throw is disclosed.
      for (const check of named) {
        try {
          drafts.push(...(await check.run(ctx)));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          gaps.push(checkGap(check.name, message));
        }
      }

      return { drafts, gaps };
    },
  };
}
