/**
 * Red Hat Design System (RHDS) rulepack provider: checks that RHDS elements are put together the
 * way the RHDS element documentation says they must be. Each rule quotes its source in sources.ts.
 * This unit must never mint a verdict. It returns Drafts so the gate stays the only authority.
 */
import type {
  CoverageGap,
  Draft,
  Provider,
  ProviderContext,
  ProviderOutput,
} from '../../contracts/index.js';
import { DECIDED_ON_PAGE } from '../applicability.js';
import { packNotApplicable } from '../design-system-pack.js';
import { RHDS_LAYER } from './draft.js';
import { checkRhdsAccordionHeaderParent } from './rhds-accordion-header-parent.js';
import { checkRhdsButtonAccessibleLabel } from './rhds-button-accessible-label.js';
import { checkRhdsCtaLink } from './rhds-cta-link.js';
import { checkRhdsDialogName } from './rhds-dialog-name.js';
import { checkRhdsSkipLinkTarget } from './rhds-skip-link-target.js';
import { checkRhdsSwitchLabel } from './rhds-switch-label.js';
import { checkRhdsTabsPaired } from './rhds-tabs-paired.js';
import { RHDS_RULES, RHDS_TAGS } from './sources.js';

type RhdsCheck = (ctx: ProviderContext) => Promise<Draft[]>;

interface NamedCheck {
  name: string;
  run: RhdsCheck;
}

/**
 * The marker that says RHDS is on the page: any element the pinned release defines, in the top
 * document, where the rules read.
 */
export const RHDS_MARKER = RHDS_TAGS.join(', ');

// Every check only reads the page. None clicks or presses keys, so the pack leaves the page as the
// browser loaded it for the providers after it.
const CHECKS: NamedCheck[] = [
  { name: 'rhds-button-accessible-label', run: checkRhdsButtonAccessibleLabel },
  { name: 'rhds-cta-link', run: checkRhdsCtaLink },
  { name: 'rhds-tabs-paired', run: checkRhdsTabsPaired },
  { name: 'rhds-dialog-name', run: checkRhdsDialogName },
  { name: 'rhds-switch-label', run: checkRhdsSwitchLabel },
  { name: 'rhds-accordion-header-parent', run: checkRhdsAccordionHeaderParent },
  { name: 'rhds-skip-link-target', run: checkRhdsSkipLinkTarget },
];

// One check that throws must not drop the other checks' drafts. It becomes a scoped gap that names
// the check and the error, because silence is not evidence.
function checkGap(name: string, message: string): CoverageGap {
  return {
    ref: `provider:rhds-rulepack/${name}`,
    state: 'not-covered',
    reason: `rhds rulepack check ${name} failed: ${message}`,
  };
}

export function makeRhdsRulepackProvider(extraChecks: RhdsCheck[] = []): Provider {
  return {
    id: 'rhds-rulepack',
    layer: RHDS_LAYER,
    capabilities: ['live'],
    // RHDS is used on content sites as well as applications, so the pack runs on both profiles.
    // It runs only where the page has an RHDS element, which only the page can say.
    appliesBeforeScan: () => ({ applies: true, why: DECIDED_ON_PAGE }),
    async run(ctx: ProviderContext): Promise<ProviderOutput> {
      const notApplicable = await packNotApplicable(ctx, {
        id: 'rhds-rulepack',
        layer: RHDS_LAYER,
        name: 'RHDS',
        marker: RHDS_MARKER,
        rules: RHDS_RULES,
      });
      if (notApplicable !== null) {
        return notApplicable;
      }

      const named: NamedCheck[] = [
        ...CHECKS,
        ...extraChecks.map((run, index) => ({ name: `extra-check-${index + 1}`, run })),
      ];

      const drafts: Draft[] = [];
      const gaps: CoverageGap[] = [];
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
