/**
 * The rule ids the shipped checks can report, for the sensitivity catalog.
 * The catalog names the rules it expects to report each declared defect, and the attestation lists
 * every rule of the deterministic checks the catalog does not exercise. Both read the ids from here,
 * so a rule cannot be expected that does not exist, and a deterministic rule cannot be left out of
 * the attestation silently. A rule that only gives preview findings is not listed here.
 * Measurement only: nothing here runs a check or decides a verdict.
 */
import axe from 'axe-core';
import { PF_RULES } from '../../providers/rulepack/index.js';
import { RHDS_RULES } from '../../providers/rhds/sources.js';

// The keyboard walk writes these ids. A unit test reads the provider source and keeps this list
// equal to the ids it writes.
export const KEYBOARD_WALK_RULES: readonly string[] = [
  'keyboard-walk-trap',
  'keyboard-walk-truncated',
  'keyboard-walk-unconfirmed-focus',
  'keyboard-walk-unnamed-interactive',
];

// The docs rulepack writes this id. The same test keeps it equal to the source.
export const DOCS_RULES: readonly string[] = ['docs-heading-order'];

// Rules a design requirement creates. Their ids carry the requirement id, so the catalog names the
// family with a trailing star, such as `intake:*`, and any requirement's rule matches it.
export const RULE_FAMILIES: readonly string[] = ['intake:'];

export interface ShippedRule {
  rule: string;
  layer: 'axe' | 'pf' | 'rhds' | 'walk' | 'docs-content';
  // axe-core keeps some rules off unless a caller turns them on. usabl does not, so they never run.
  offByDefault?: true;
}

function axeRules(): ShippedRule[] {
  return axe.getRules().map((rule): ShippedRule => {
    const experimental = rule.tags.includes('experimental');
    return experimental ? { rule: rule.ruleId, layer: 'axe', offByDefault: true } : { rule: rule.ruleId, layer: 'axe' };
  });
}

/** Every rule id a shipped deterministic check can report, sorted by id. */
export function shippedRules(): ShippedRule[] {
  const rules: ShippedRule[] = [
    ...axeRules(),
    ...PF_RULES.map((rule): ShippedRule => ({ rule, layer: 'pf' })),
    ...RHDS_RULES.map((rule): ShippedRule => ({ rule, layer: 'rhds' })),
    ...KEYBOARD_WALK_RULES.map((rule): ShippedRule => ({ rule, layer: 'walk' })),
    ...DOCS_RULES.map((rule): ShippedRule => ({ rule, layer: 'docs-content' })),
  ];
  return rules.sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

/** Whether a rule id the catalog names is one a shipped check reports, or a requirement family. */
export function isKnownRulePattern(pattern: string, known: ReadonlySet<string>): boolean {
  if (pattern.endsWith('*')) {
    return RULE_FAMILIES.includes(pattern.slice(0, -1));
  }
  return known.has(pattern);
}

/** Whether a reported rule id matches a catalog pattern: exact, or within a family. */
export function ruleMatches(pattern: string, rule: string): boolean {
  if (pattern.endsWith('*')) {
    return rule.startsWith(pattern.slice(0, -1));
  }
  return rule === pattern;
}
