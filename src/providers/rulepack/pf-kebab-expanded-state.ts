/**
 * Static kebab toggle state check for PatternFly menus.
 * DOM attributes prove state presence because Chromium can omit false values from AX properties.
 */
import type { Draft, EvidenceFacts, Fact, ProviderContext } from '../../contracts/index.js';
import { SEL } from './selectors.js';

interface MenuStateAttributes {
  expanded: string | null;
  haspopup: string | null;
}

function makeStateEvidence(
  states: Record<string, unknown>,
  attributes: MenuStateAttributes,
): Record<string, Fact<unknown>> | undefined {
  const facts: Record<string, Fact<unknown>> = {};
  if (attributes.expanded !== null) {
    facts.expanded = { value: attributes.expanded, source: 'attribute', fromTree: false };
  } else if (Object.hasOwn(states, 'expanded')) {
    facts.expanded = { value: states.expanded, source: 'ax-tree', fromTree: true };
  }
  if (attributes.haspopup !== null) {
    facts.haspopup = { value: attributes.haspopup, source: 'attribute', fromTree: false };
  } else if (Object.hasOwn(states, 'haspopup')) {
    facts.haspopup = { value: states.haspopup, source: 'ax-tree', fromTree: true };
  }
  if (Object.keys(facts).length === 0) {
    return undefined;
  }
  return facts;
}

function makeEvidence(
  nodeName: string | null,
  nodeRole: string | null,
  states: Record<string, unknown>,
  attributes: MenuStateAttributes,
): EvidenceFacts {
  const state = makeStateEvidence(states, attributes);
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

    const attributes = {
      expanded: await ctx.page.getAttribute(toggle.selector, 'aria-expanded'),
      haspopup: await ctx.page.getAttribute(toggle.selector, 'aria-haspopup'),
    };
    const hasExpanded = attributes.expanded !== null || Object.hasOwn(node.states, 'expanded');
    const hasHaspopup = attributes.haspopup !== null || Object.hasOwn(node.states, 'haspopup');
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
      why: 'The menu toggle is missing aria-expanded or aria-haspopup state.',
      fix: 'Expose both expanded and haspopup state on the toggle element.',
      evidence: makeEvidence(node.name, node.role, node.states, attributes),
      confidence: 'fail',
    });
  }

  return drafts;
}
