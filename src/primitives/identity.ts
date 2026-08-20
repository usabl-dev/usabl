import type { Draft, IdentityBasis } from '../contracts/index.js';
import { slug } from './slug.js';

/**
 * Finding identity is how the gate tells "this control, this rule" from markup churn.
 * The key excludes `layer` so axe and PatternFly reports of the same defect can dedup.
 *
 * Priority:
 * 1. name - accessible name from evidence. Survives class and DOM reshuffles.
 * 2. structural - role plus a path with nth-child indexes stripped. Weaker than a name.
 * 3. count - identity-weak rules. An unnamed control cannot honestly be keyed by name.
 *    The floor then compares how many such findings exist, not which node they were.
 */
export const IDENTITY_WEAK = new Set<string>(['button-name', 'pf-icon-button-name']);

/** Drop volatile positional selectors so the same control keeps the same structural key. */
function neutralizePath(path: string): string {
  return path
    .replace(/:nth-of-type\(\d+\)/g, '')
    .replace(/:nth-child\(\d+\)/g, '')
    .replace(/\s*>\s*/g, '>')
    .replace(/\s+/g, '');
}

/**
 * Layer-independent identity for a Draft.
 * Returns `elementKey: null` for count-based rules; callers must not invent a name key.
 */
export function computeIdentity(draft: Draft): { elementKey: string | null; identityBasis: IdentityBasis } {
  const base = `${draft.screenId}|${draft.rule}`;
  if (IDENTITY_WEAK.has(draft.rule)) {
    return { elementKey: null, identityBasis: 'count' };
  }
  const name = draft.evidence.name?.value;
  if (name) {
    return { elementKey: `${base}|name:${slug(name)}`, identityBasis: 'name' };
  }
  const role = draft.role ?? 'unknown';
  return { elementKey: `${base}|struct:${role}:${neutralizePath(draft.elementPath)}`, identityBasis: 'structural' };
}
