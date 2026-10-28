import type { Draft, EvidenceFloor, IdentityBasis } from '../contracts/index.js';
import { slug } from './slug.js';

/**
 * Finding identity is how the gate tells "this control, this rule" from markup churn.
 * The key excludes `layer` so axe and PatternFly reports of the same defect can dedup.
 *
 * Priority:
 * 0. row - a control inside a keyed table row: the row's key (hashed), the control's role, and its
 *    place in the row. Only under the row-scoped scheme. See computeIdentity.
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
export function neutralizePath(path: string): string {
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
 * Where a control sits inside a keyed table row, as the check runner recorded it on the draft in
 * `evidence.extra.rowScope`. Every field is a string the check runner already made safe for a key:
 * `table` is a neutralized structural path, `row` is a hash of the row's key and never the key
 * itself, `role` is folded to a token, and `path` is tag and child position from the row down.
 */
export interface RowScope {
  table: string;
  row: string;
  role: string;
  path: string;
}

/**
 * The row scope on a draft, or null. A draft can come from a library caller, so the shape is
 * checked here rather than trusted: anything that is not four strings with a non-empty row is
 * treated as no row scope, and the draft keys the way it did before row keys existed.
 */
export function readRowScope(draft: Draft): RowScope | null {
  const extra = draft.evidence.extra;
  if (typeof extra !== 'object' || extra === null) return null;
  const scope: unknown = extra['rowScope'];
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) return null;
  const record = scope as Record<string, unknown>;
  const { table, row, role, path } = record;
  if (typeof table !== 'string' || typeof row !== 'string' || typeof role !== 'string' || typeof path !== 'string') {
    return null;
  }
  if (row.length === 0) return null;
  return { table, row, role, path };
}

/**
 * Which keys a comparison uses. 'row-scoped' keys a control in a keyed table row per row.
 * 'legacy' is the scheme version 1 and 2 floors were written with, where those controls collapse
 * across rows.
 */
export type IdentityScheme = 'row-scoped' | 'legacy';

/** The floor version `usabl baseline` writes. Version 3 is the first with row keys. */
export const FLOOR_VERSION = 3;

/**
 * The scheme that compares a run against this floor. A floor is compared with the keys it was
 * written with, because comparing a version 2 floor with row keys would read every collapsed entry
 * as fixed and every row barrier under it as new. An empty floor has nothing to compare, so it takes
 * the current scheme, and the findings a first run reports carry the keys a baseline will write.
 */
export function identitySchemeFor(floor: Pick<EvidenceFloor, 'version' | 'entries'>): IdentityScheme {
  return floor.version >= FLOOR_VERSION || floor.entries.length === 0 ? 'row-scoped' : 'legacy';
}

/**
 * Layer-independent identity for a Draft.
 * Returns `elementKey: null` for count-based rules; callers must not invent a name key.
 *
 * Under the row-scoped scheme a draft with a row scope keys by the row first, ahead of a name and
 * ahead of the count basis. Repeated controls are exactly the ones that share a name ("Edit" in
 * every row) or have none (an icon button in every row), so neither a name nor a count tells one
 * row from another. The row part is JSON-encoded so a separator inside a field cannot make two
 * different rows share a key.
 */
export function computeIdentity(
  draft: Draft,
  scheme: IdentityScheme = 'row-scoped',
): { elementKey: string | null; identityBasis: IdentityBasis } {
  const base = `${draft.screenId}|${draft.rule}`;
  if (scheme === 'row-scoped') {
    const row = readRowScope(draft);
    if (row !== null) {
      return { elementKey: `${base}|row:${JSON.stringify([row.table, row.row, row.role, row.path])}`, identityBasis: 'row' };
    }
  }
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
