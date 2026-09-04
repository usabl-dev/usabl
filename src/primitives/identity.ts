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

/**
 * Framework ids that are minted fresh on every mount, listed by producer rather than
 * guessed at. React's `useId` returns `:r<base36 counter>:`, which a CSS selector
 * escapes to `\:r39\:`, and that escaped form is what the page driver hands us.
 * PatternFly wraps the same value as `pf-random-id-<useId>` and older builds use a
 * plain counter. Nothing else is treated as generated: a rule like "ids with digits
 * are volatile" would also erase `#cluster-list-2`, which an author wrote and which
 * is real identity. Requiring the escaped colon also keeps `input:required:focus`
 * out of the React pattern.
 */
const GENERATED_IDS: Array<[RegExp, string]> = [
  [/pf-random-id-[\\:0-9a-z]+/g, 'pf-random-id-{generated-id}'],
  [/\\:r[0-9a-z]+\\:/g, '{generated-id}'],
];

/**
 * Drop volatile positional selectors so the same control keeps the same structural key.
 * Generated ids become a placeholder rather than being deleted, because the segment
 * still separates siblings whose paths are otherwise identical.
 */
function neutralizePath(path: string): string {
  let out = path;
  for (const [pattern, placeholder] of GENERATED_IDS) out = out.replace(pattern, placeholder);
  return out
    .replace(/:nth-of-type\(\d+\)/g, '')
    .replace(/:nth-child\(\d+\)/g, '')
    .replace(/\s*>\s*/g, '>')
    .replace(/\s+/g, '');
}

/**
 * Cross-layer / floor map key. Layer is omitted so axe and PatternFly reports of the same
 * defect collapse to one identity. Keep this helper in one place: gate, baseline, and floor
 * prune must agree on the string or a paid-down barrier can reappear as carried debt, and a
 * carried barrier can gate as new.
 */
export function identityKey(value: { screenId: string; rule: string; elementKey: string | null }): string {
  return `${value.screenId}|${value.rule}|${value.elementKey ?? 'count'}`;
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
