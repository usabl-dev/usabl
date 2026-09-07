/**
 * The one refusal `usabl init` and `usabl init --docs` make when a derived id fails the id grammar.
 *
 * A route or page whose id is refused cannot be written, and it cannot be left out either. A
 * written sidecar takes precedence over router fallback, and the planners queue every entry in
 * the sidecar or manifest on a wide-blast or shared-file change while recording no gap for an
 * entry that is not there. A draft missing one route or page would therefore let such a change
 * read as fully checked while that screen is never scanned. The only honest draft is none at
 * all: init collects every unusable id and refuses the whole draft through this unit, naming
 * each one by where to look (a file, or a file and line), with the position and code point when
 * a character was refused and the grammar reason otherwise, and never the id or the text it was
 * derived from. This unit formats text only. It must never decide which ids are refused.
 */
import { operatorText } from '../intake/config-error.js';
import { describeIdRefusal, type IdGrammarRefusal } from '../intake/id-grammar.js';

/** One id init could not use: where it came from and why the grammar refused it. */
export interface UnusableId {
  // Where to look. A file, or a file and line. Never the id, and never the text it came from.
  source: string;
  // What the id was made from, so the fix names the right thing to change.
  origin: string;
  refusal: IdGrammarRefusal;
}

/** The words that differ between the two init commands. */
export interface RefusalContext {
  command: string;
  // The files the command would have written.
  written: string;
  // What one entry is called: 'route' or 'page'.
  noun: string;
  // Why leaving the entry out is not an option. Ends without a period; the sentence continues.
  loss: string;
  // What to change. Ends without a period.
  fix: string;
}

export const APP_INIT_REFUSAL: RefusalContext = {
  command: 'usabl init',
  written: 'usabl.config.json and usabl.routes.json',
  noun: 'route',
  loss: 'A sidecar that left the route out would let a change to a shared entry file or a wide-blast file look fully checked while that route is never scanned,',
  fix: 'change the route path in the router file so the screen id derived from it uses visible characters with no spaces',
};

export const DOCS_INIT_REFUSAL: RefusalContext = {
  command: 'usabl init --docs',
  written: 'usabl.docs.json',
  noun: 'page',
  loss: 'A manifest that left the page out would let a change to a shared file look fully checked while that page is never scanned,',
  fix: 'rename the anchor, or the file when the id was guessed from the filename or path, so the id uses visible characters with no spaces',
};

export function unusableIdsError(context: RefusalContext, items: readonly UnusableId[]): Error {
  const count =
    items.length === 1 ? `one ${context.noun} has an id` : `${items.length} ${context.noun}s have ids`;
  // An id that is not in NFC form has nothing to rename in the visible sense: it looks right and
  // is spelled with a different sequence of code points. The fix for that one is to normalize.
  const needsNormalizing = items.some((item) => item.refusal.problem === 'not-nfc');
  const lines = [
    `${context.command} refused to write ${context.written}: ${count} usabl would refuse to read. ${context.loss} so nothing was written.`,
    ...items.map((item) => `  ${operatorText(item.source)}: ${item.origin} ${describeIdRefusal(item.refusal)}`),
    `Fix: ${context.fix}.` +
      (needsNormalizing
        ? ' An id that is not in NFC form must be normalized to NFC, or retyped, so that it is.'
        : '') +
      ` Then run ${context.command} again.`,
  ];
  return new Error(lines.join('\n'));
}
