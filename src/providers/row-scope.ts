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
 * Three outcomes, and they are kept apart. A finding outside a keyed row keys the way it did before
 * row keys existed, and nothing is lost. A finding in a row usabl can tell apart from every other
 * row gets a row scope. A finding in a row of a keyed table that cannot be told apart, or whose row
 * could not be read, keeps the old key and is marked unverified, and the scan reports a not-covered
 * gap for its screen and rule: under the old key a new barrier in one row can fill a count accepted
 * for another and read as carried, so the run cannot prove it is not hiding there.
 */
import type { CoverageGap, Draft, Page, RowAmbiguity, RowContextRead } from '../contracts/index.js';
import { sha256 } from '../primitives/canonical.js';
import { slug } from '../primitives/slug.js';

// Sixteen hex characters, 64 bits. Enough that two rows of one screen never share a token by
// chance, short enough to read in a floor diff.
const TOKEN_LENGTH = 16;

/** A hash of a page-derived identifier. The identifier itself is never kept. */
function token(kind: string, value: string): string {
  return sha256(JSON.stringify([kind, value])).slice(0, TOKEN_LENGTH);
}

/** The path from the row down to the element, with white space around each step removed. */
function compactPath(path: string): string {
  return path.replace(/\s*>\s*/g, '>').replace(/\s+/g, '');
}

type Keyed = Extract<RowContextRead, { kind: 'keyed' }>;

function rowScopeOf(read: Keyed): Record<string, string> {
  return {
    table: token('table', read.table),
    row: token(read.source, read.key),
    role: slug(read.role) || 'unknown',
    path: compactPath(read.path),
  };
}

// Why a row could not be keyed, in words an operator can act on. Never the key itself.
type Unkeyed = RowAmbiguity | 'unreadable';

const WHY: Record<Unkeyed, string> = {
  'row-key-missing': 'a row has no key while other rows of its table have one',
  'row-key-duplicate': 'two rows of one table share a key',
  'row-key-too-long': 'a row key or a table name is too long to read',
  'table-ambiguous': 'two tables on the screen cannot be told apart',
  unreadable: 'usabl could not read the row',
};

async function readRow(page: Page, selector: string): Promise<RowContextRead | { kind: 'unreadable' }> {
  const trimmed = selector.trim();
  if (trimmed === '') {
    return { kind: 'none' };
  }
  try {
    return await page.rowContext(trimmed);
  } catch {
    // The page could not be read. Whether the element sits in a row is unknown, so it is disclosed
    // rather than read as outside a row. The error text is not repeated: it is not needed to act.
    return { kind: 'unreadable' };
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
      `in table rows usabl could not tell apart (${reasons}), so this run cannot prove that a new barrier in one row ` +
      'is not hiding behind one accepted in another. To fix: give ' +
      'every body row of each table a key attribute such as data-row-key, or a row header, that no other row of that ' +
      'table holds, and give each table an id, a caption, or an accessible name that no other table on the screen shares.',
  };
}

export async function attachRowScopeToDrafts(
  page: Page,
  screen: { id: string; url: string },
  drafts: Draft[],
): Promise<{ drafts: Draft[]; gaps: CoverageGap[] }> {
  const enriched: Draft[] = [];
  const unkeyed = new Map<string, UnkeyedGroup>();
  for (const draft of drafts) {
    const read = await readRow(page, draft.elementPath);
    if (read.kind === 'keyed') {
      enriched.push({
        ...draft,
        evidence: { ...draft.evidence, extra: { ...draft.evidence.extra, rowScope: rowScopeOf(read) } },
      });
      continue;
    }
    if (read.kind === 'ambiguous' || read.kind === 'unreadable') {
      const group = unkeyed.get(draft.rule) ?? { rule: draft.rule, count: 0, why: new Set<Unkeyed>() };
      group.count += 1;
      group.why.add(read.kind === 'ambiguous' ? read.reason : 'unreadable');
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
