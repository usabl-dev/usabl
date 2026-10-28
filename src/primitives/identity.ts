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
 *
 * The encoding must be injective: two different field triples must never produce the same key.
 * A plain "a|b|c" join is not, because a screenId or an intake-generated rule can itself contain
 * "|", so (screenId="a|b", rule="c") and (screenId="a", rule="b|c") would collide and let one
 * finding be marked carried against the other's floor entry. JSON.stringify of the fixed-length
 * tuple escapes the delimiter and the field contents, so the key is one-to-one with the triple.
 */
export function identityKey(value: { screenId: string; rule: string; elementKey: string | null }): string {
  return JSON.stringify([value.screenId, value.rule, value.elementKey ?? 'count']);
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

/**
 * The element an identity is about, without the rule: "path:<neutralized path>" for a structural
 * key and "name:<slug>" for a name key. Null for a counted identity, which names no element, and
 * for a key that does not have the shape computeIdentity writes.
 *
 * Read off the key itself, so a floor entry needs no extra field. A key this cannot read returns
 * null, and a caller that needs an element to be present then treats it as absent.
 */
export function identitySlot(value: {
  screenId: string;
  rule: string;
  elementKey: string | null;
  identityBasis: IdentityBasis;
}): string | null {
  if (value.elementKey === null || value.identityBasis === 'count') return null;
  const prefix = `${value.screenId}|${value.rule}|`;
  if (!value.elementKey.startsWith(prefix)) return null;
  const rest = value.elementKey.slice(prefix.length);
  if (value.identityBasis === 'name') {
    return rest.startsWith('name:') ? rest : null;
  }
  if (!rest.startsWith('struct:')) return null;
  // struct:<role>:<path>. A role never holds a colon, and a path can, so split at the first one.
  const roleAndPath = rest.slice('struct:'.length);
  const colon = roleAndPath.indexOf(':');
  return colon < 0 ? null : `path:${roleAndPath.slice(colon + 1)}`;
}

/**
 * The slots one observed element fills: its neutralized path, and its accessible name when it has
 * one. The same encoding identitySlot reads off a key, so an element this run saw and a floored
 * identity about that element compare equal.
 */
export function elementSlots(element: { elementPath: string; name: string | null }): string[] {
  const slots = [`path:${neutralizePath(element.elementPath)}`];
  if (element.name !== null && element.name.length > 0) {
    slots.push(`name:${slug(element.name)}`);
  }
  return slots;
}
