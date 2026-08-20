/**
 * Static kebab toggle state check for PatternFly menus.
 * This unit must never guess missing states when the accessibility tree has no node.
 */
import type { Draft, EvidenceFacts, Fact, ProviderContext } from '../../contracts/index.js';
import { SEL } from './selectors.js';

function makeStateEvidence(
  states: Record<string, unknown>,
): Record<string, Fact<unknown>> | undefined {
  const facts: Record<string, Fact<unknown>> = {};
  if (Object.hasOwn(states, 'expanded')) {
    facts.expanded = { value: states.expanded, source: 'ax-tree', fromTree: true };
  }
  if (Object.hasOwn(states, 'haspopup')) {
    facts.haspopup = { value: states.haspopup, source: 'ax-tree', fromTree: true };
  }
  if (Object.keys(facts).length === 0) {
    return undefined;
  }
  return facts;
}

function makeEvidence(nodeName: string | null, nodeRole: string | null, states: Record<string, unknown>): EvidenceFacts {
  const state = makeStateEvidence(states);
  if (state) {
    return {
      name: { value: nodeName, source: 'ax-tree', fromTree: true },
      role: { value: nodeRole, source: 'ax-tree', fromTree: true },
      state,
    };
  }
  return {
    name: { value: nodeName, source: 'ax-tree', fromTree: true },
    role: { value: nodeRole, source: 'ax-tree', fromTree: true },
  };
}

export async function checkPfKebabExpandedState(ctx: ProviderContext): Promise<Draft[]> {
  const toggles = await ctx.page.queryAll(SEL.menuToggle);
  const drafts: Draft[] = [];

  for (const toggle of toggles) {
    const node = await ctx.page.axAt(toggle.selector);
    if (node === null) {
      continue;
    }

    const hasExpanded = Object.hasOwn(node.states, 'expanded');
    const hasHaspopup = Object.hasOwn(node.states, 'haspopup');
    if (hasExpanded && hasHaspopup) {
      continue;
    }

    drafts.push({
      rule: 'pf-kebab-expanded-state',
      layer: 'pf',
      severity: 'serious',
      evidenceClass: 'deterministic',
      screenId: ctx.screen.id,
      elementPath: toggle.selector,
      elementName: node.name,
      role: node.role,
      whatUserExperiences: 'A menu toggle does not announce whether it controls an expanded menu.',
      why: 'The accessibility tree is missing expanded or haspopup state on the menu toggle.',
      fix: 'Expose both expanded and haspopup state on the toggle element.',
      evidence: makeEvidence(node.name, node.role, node.states),
      confidence: 'fail',
    });
  }

  return drafts;
}
