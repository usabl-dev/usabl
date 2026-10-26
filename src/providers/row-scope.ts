/**
 * Attach the table row a finding's element sits in, so the gate can key a control repeated in every
 * row per row. It runs after the providers, on the live page, the way the DOM source hint does.
 *
 * The row and its table are named by page text: a key attribute, a row header, a caption, an id.
 * That text is often customer data, such as a host or a user name. It never leaves this module: it
 * is hashed, exactly and in full, at once, and only the hash is stored. Hashing the exact value
 * matters as much as hashing at all: the page reader checks that no two rows share a key by
 * comparing exact strings, so anything that folded case or cut the value here could make two rows
 * the page reader told apart share one hash.
 *
 * Three outcomes, and they are kept apart. A finding whose element was found outside every keyed
 * row keys the way it did before row keys existed, and nothing is lost. A finding in a row usabl can
 * tell apart from every other row gets a row scope. Every other finding keeps the old key and is
 * marked unverified, and the scan reports a not-covered gap for its screen and rule: a row of a
 * keyed table that cannot be told apart, a row whose hash another row or table shares, a row that
 * could not be read, and an element the scanner named that cannot be found again as exactly one
 * element. Under the old key a new barrier in one row can fill a count accepted for another and read
 * as carried, so the run cannot prove it is not hiding there.
 */
import type { CoverageGap, Draft, Page, RowAmbiguity, RowContextRead, RowUnreadable } from '../contracts/index.js';
import { sha256 } from '../primitives/canonical.js';
import { slug } from '../primitives/slug.js';

// Sixteen hex characters, 64 bits. Enough that two rows of one screen almost never share a token by
// chance, short enough to read in a floor diff. The rare case where they do is checked below.
const TOKEN_LENGTH = 16;

/** Hashes text to hex. Injected only by tests, to force two tokens to collide. */
export type RowHash = (text: string) => string;

/** A hash of a page-derived identifier. The identifier itself is never kept. */
function token(hash: RowHash, kind: string, value: string): string {
  return hash(JSON.stringify([kind, value])).slice(0, TOKEN_LENGTH);
}

/** The path from the row down to the element, with white space around each step removed. */
function compactPath(path: string): string {
  return path.replace(/\s*>\s*/g, '>').replace(/\s+/g, '');
}

type Keyed = Extract<RowContextRead, { kind: 'keyed' }>;

/**
 * The row scope, or null when a token collides. The page checked that the exact key and table text
 * are unique, but only 16 hex characters of each hash are kept, so two different texts could still
 * share one token and then one identity. The tokens are checked again here, against the table's
 * other rows and the screen's other tables.
 */
function rowScopeOf(read: Keyed, hash: RowHash): Record<string, string> | null {
  const table = token(hash, 'table', read.table);
  const row = token(hash, read.source, read.key);
  if (read.otherKeys.some((other) => token(hash, read.source, other) === row)) return null;
  if (read.otherTables.some((other) => token(hash, 'table', other) === table)) return null;
  return { table, row, role: slug(read.role) || 'unknown', path: compactPath(read.path) };
}

// Why a row could not be keyed, in words an operator can act on. Never the key itself.
type Unkeyed = RowAmbiguity | RowUnreadable | 'hash-collision' | 'read-failed';

const WHY: Record<Unkeyed, string> = {
  'row-key-missing': 'a row has no key while other rows of its table have one',
  'row-key-duplicate': 'two rows of one table share a key',
  'row-key-too-long': 'a row key or a table name is too long to read',
  'table-ambiguous': 'two tables on the screen cannot be told apart',
  'enclosing-row-unkeyed': 'a table sits in a row of another table whose rows have no key',
  'hash-collision': 'two rows or two tables have the same short hash',
  'selector-invalid': 'usabl could not use the selector the scanner gave for the element',
  'element-missing': 'usabl could not find the element again after the scan, so it may have left the page',
  'element-multiple': 'the selector the scanner gave matched more than one element',
  'read-failed': 'usabl could not read the row',
};

type RowRead = RowContextRead | { kind: 'read-failed' };

async function readRow(page: Page, selector: string): Promise<RowRead> {
  const trimmed = selector.trim();
  if (trimmed === '') {
    // No selector means the finding is about the page or the walk, not an element, so no row.
    return { kind: 'none' };
  }
  try {
    return await page.rowContext(trimmed);
  } catch {
    // The page could not be read. Whether the element sits in a row is unknown, so it is disclosed
    // rather than read as outside a row. The error text is not repeated: it is not needed to act.
    return { kind: 'read-failed' };
  }
}

/** Why a read did not key the row, or null when the element was found outside any keyed row. */
function unkeyedReason(read: RowRead): Unkeyed | null {
  switch (read.kind) {
    case 'none':
      return null;
    case 'keyed':
      return 'hash-collision';
    case 'ambiguous':
    case 'unreadable':
      return read.reason;
    default:
      // A failed read, or a shape this code does not know, is no proof the element is outside a row.
      return 'read-failed';
  }
}

interface UnkeyedGroup {
  rule: string;
  count: number;
  why: Set<Unkeyed>;
}

function gapFor(screen: { id: string; url: string }, group: UnkeyedGroup): CoverageGap {
  const reasons = [...group.why].sort().map((why) => WHY[why]).join('; ');
  return {
    ref: screen.url,
    state: 'not-covered',
    reason:
      `on screen ${screen.id}, rule ${group.rule}: ${group.count} ${group.count === 1 ? 'barrier sits' : 'barriers sit'} ` +
      `in table rows usabl could not tell apart, or on elements it could not find again (${reasons}), so this run ` +
      'cannot prove that a new barrier in one row is not hiding behind one accepted in another. To fix: give ' +
      'every body row of each table a key attribute such as data-row-key, or a row header, that no other row of that ' +
      'table holds, key the rows of any table another table sits in, and give each table an id, a caption, or an ' +
      'accessible name that no other table on the screen shares. If an element left the page during the scan, make ' +
      'the screen hold still once it has rendered, then run usabl again.',
  };
}

export async function attachRowScopeToDrafts(
  page: Page,
  screen: { id: string; url: string },
  drafts: Draft[],
  options: { hash?: RowHash } = {},
): Promise<{ drafts: Draft[]; gaps: CoverageGap[] }> {
  const hash = options.hash ?? sha256;
  const enriched: Draft[] = [];
  const unkeyed = new Map<string, UnkeyedGroup>();
  for (const draft of drafts) {
    const read = await readRow(page, draft.elementPath);
    const rowScope = read.kind === 'keyed' ? rowScopeOf(read, hash) : null;
    if (rowScope !== null) {
      enriched.push({
        ...draft,
        evidence: { ...draft.evidence, extra: { ...draft.evidence.extra, rowScope } },
      });
      continue;
    }
    const reason = unkeyedReason(read);
    if (reason !== null) {
      const group = unkeyed.get(draft.rule) ?? { rule: draft.rule, count: 0, why: new Set<Unkeyed>() };
      group.count += 1;
      group.why.add(reason);
      unkeyed.set(draft.rule, group);
      // The barrier is real, but which accepted barrier it is, if any, is not known: its row cannot
      // be told apart. Calling it new would be a guess, and a wrong guess must be a gap, not a
      // finding. So it is marked unverified, which keeps it blocking as not covered, never as
      // carried and never as a regression the floor already accepted.
      enriched.push(draft.confidence === 'fail' ? { ...draft, confidence: 'unverified' } : draft);
      continue;
    }
    enriched.push(draft);
  }
  const gaps = [...unkeyed.values()]
    .sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0))
    .map((group) => gapFor(screen, group));
  return { drafts: enriched, gaps };
}
