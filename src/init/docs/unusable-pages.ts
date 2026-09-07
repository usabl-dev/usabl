/**
 * The one refusal `usabl init --docs` makes when a derived page id fails the id grammar.
 *
 * A page whose id is refused cannot be written, and it cannot be left out either. The docs
 * planner queues every page in the manifest when a shared file changes and records no gap for a
 * page that is not there, so a manifest missing one page would let a shared-file change read as
 * fully checked while that page is never scanned. The only honest draft is therefore none at
 * all: both adapters collect every unusable page and refuse the whole draft through this unit,
 * naming each page by file with the position and code point of the refused character and never
 * the id. This unit formats text only. It must never decide which ids are refused.
 */
import { operatorText } from '../../intake/config-error.js';

/** One page init could not name: the file it came from and why the id grammar refused it. */
export interface UnusablePage {
  file: string;
  // What the id was made from, so the fix names the right thing to rename.
  origin: 'its anchor pageId' | 'the pageId guessed from its filename' | 'the pageId slugged from its path';
  problem: string;
}

export function unusablePagesError(pages: readonly UnusablePage[]): Error {
  const noun = pages.length === 1 ? 'one page has an id' : `${pages.length} pages have ids`;
  const lines = [
    `usabl init --docs refused to write usabl.docs.json: ${noun} usabl would refuse to read. A manifest that left the page out would let a change to a shared file look fully checked while that page is never scanned, so nothing was written.`,
    ...pages.map((page) => `  ${operatorText(page.file)}: ${page.origin} ${page.problem}`),
    'Fix: rename the anchor, or the file when the id was guessed from the filename or path, so the id uses visible characters with no spaces, then run usabl init --docs again.',
  ];
  return new Error(lines.join('\n'));
}
