/**
 * Attach the table row a finding's element sits in, so the gate can key a control repeated in every
 * row per row. It runs after the providers, on the live page, the way the DOM source hint does.
 *
 * The row is named by its key attribute or its row header, which is page text and often customer
 * data such as a host or user name. That text never leaves this module: it is folded and hashed at
 * once, and only the hash is stored. The committed floor therefore carries no more page text than it
 * did before row keys existed.
 *
 * It never throws and never drops a finding. A row that cannot be read leaves the draft as it came,
 * and the draft keys the way it did before row keys existed.
 */
import type { Draft, Page, RowContextRead } from '../contracts/index.js';
import { sha256 } from '../primitives/canonical.js';
import { neutralizePath } from '../primitives/identity.js';
import { neutralize } from '../primitives/neutralize.js';
import { slug } from '../primitives/slug.js';

// Sixteen hex characters, 64 bits. Enough that two rows of one table never share a token by chance,
// short enough to read in a floor diff.
const ROW_TOKEN_LENGTH = 16;

/**
 * The row key folded so markup churn does not move it: control characters removed, runs of white
 * space made one space, trimmed, and lower case. Empty means the row has no usable key.
 */
function foldRowKey(text: string): string {
  return neutralize(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A row token: a hash of where the key came from and the folded key. Never the key itself. */
function rowToken(source: string, folded: string): string {
  return sha256(`${source}\u0000${folded}`).slice(0, ROW_TOKEN_LENGTH);
}

/** The path from the row down to the element, with white space around each step removed. */
function compactPath(path: string): string {
  return path.replace(/\s*>\s*/g, '>').replace(/\s+/g, '');
}

function rowScopeOf(read: RowContextRead): Record<string, string> | null {
  const folded = foldRowKey(read.text);
  if (folded.length === 0) {
    return null;
  }
  return {
    table: neutralizePath(read.table),
    row: rowToken(read.source, folded),
    role: slug(read.role) || 'unknown',
    path: compactPath(read.path),
  };
}

async function readRowScope(page: Page, selector: string): Promise<Record<string, string> | null> {
  const trimmed = selector.trim();
  if (trimmed === '') {
    return null;
  }
  try {
    const read = await page.rowContext(trimmed);
    return read === null ? null : rowScopeOf(read);
  } catch {
    // A malformed selector, or an element that left the page, makes the read throw. The finding
    // stays and keys without a row, which is how it keyed before row keys existed.
    return null;
  }
}

export async function attachRowScopeToDrafts(page: Page, drafts: Draft[]): Promise<Draft[]> {
  const enriched: Draft[] = [];
  for (const draft of drafts) {
    const scope = await readRowScope(page, draft.elementPath);
    if (scope === null) {
      enriched.push(draft);
      continue;
    }
    enriched.push({
      ...draft,
      evidence: {
        ...draft.evidence,
        extra: { ...draft.evidence.extra, rowScope: scope },
      },
    });
  }
  return enriched;
}
