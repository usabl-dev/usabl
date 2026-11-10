/**
 * Pull request comment projection for a gated Result.
 * This unit renders markdown only.
 * It must never recompute findings, mint a verdict, or act as a second gate.
 */
import type {
  ConformanceSummary,
  AppSourceMapping,
  DocsSourceMapping,
  Finding,
  Result,
  TranscriptStop,
  UsablConfig,
  Verdict,
} from '../contracts/index.js';
import { neutralize } from '../primitives/neutralize.js';
import { isJudgeDisclosure, judgeLine } from '../judge/disclosure.js';
import { boundField, type TextCap } from '../output/bounded-text.js';
import { NOT_A_LIST, ownEntry, wholeNumberText } from '../output/carried.js';
import { computeConformance } from '../output/conformance.js';
import { fixOrAbsence, isBlockingBarrier, UNRECOGNIZED_GAP_STATE } from '../output/disclosure.js';
import { unconfirmedNotice } from '../output/floor-notice.js';
import { screenNotes } from '../output/notes.js';
import { debtSentence, trackingOffSentence } from '../output/debt.js';
import {
  applyNoiseBudget,
  formatCollapsedGroupCount,
  formatShowAllHint,
  resolveNoiseBudgetDefault,
  type CollapsedFindingGroup,
} from '../output/noise-budget.js';
import { formatAppSourceLocation, formatDocsSourceLocation } from '../output/source-location.js';
import { describeVerdict, formatVerdictWord } from '../output/verdict-line.js';
import {
  scrubPublishedResult,
  scrubString,
  UNTRUSTED_FRAME_END,
  UNTRUSTED_FRAME_START,
} from './scrub.js';

const COMMENT_MARKER = '<!-- usabl-report -->';
const STOP_CAP = 20;

/**
 * The longest body this surface prints, in UTF-16 code units, counted on the final text with the
 * newline the CLI adds after it.
 *
 * GitHub refuses a comment body over 65,536 characters. A refused body fails the comment job,
 * and the required check then fails with no comment to say why. GitHub counts characters, and a
 * character is never more than two UTF-16 code units, so a body under this bound in code units
 * is under GitHub's limit in characters. The margin under 65,536 is room for the workflow to
 * change how it posts the body without the bound having to move.
 */
export const COMMENT_BODY_LIMIT = 60_000;

/**
 * How many coverage gaps of one state the comment names. The rest of that state are counted on
 * one line. A pull request that touches hundreds of files no screen owns would otherwise print
 * one gap per file. The same cap the transcript uses per screen.
 */
export const GAPS_PER_STATE_CAP = 20;

// Where the full list is when this comment leaves something out. The judge uploads the Result as
// this artifact, and `usabl check --json` prints the same Result on a local machine.
const FULL_RESULT_POINTER =
  'The full Result is usabl-result.json in the usabl-result artifact of this workflow run. On your own machine, `usabl check --json` prints it.';

// Every value this document carries from the Result is written inside a code span, whoever
// authored it, and only text usabl itself wrote is left as prose.
//
// That rule replaces an argument. The values printed as prose here used to be the ones a first
// party authored: a rule, a layer, and a severity come from the providers, a status is the
// gate's own enum. That holds while a Result is built in this process. It does not hold at this
// surface's own entry point: `usabl comment` reads a Result as a document from standard input,
// the parse checks a few fields and takes the rest on trust, and a library caller can hand the
// engine a check runner of its own. A severity carrying a mention and an address was fed in that
// way and rendered as a live mention and a mailto link. Deciding by author cannot survive a
// boundary where the author is whoever wrote the document, so the decision is by carrier
// instead: if the Result carried it, it is sealed.
//
// Two kinds of text reach this Markdown document, and each gets its own defense.
//
// Page-derived text, everything inside an untrusted frame, is written as a code span. Inside a
// code span Markdown is inert: no character reference, HTML, emphasis, link, or block construct
// is read, so nothing a renderer does can delete or add characters and draw the frame marker out
// of text that is not the marker. GitHub's post-render filters, which turn an email address,
// "@user", "#123", or a commit id into a link, a mention, or a notification, run on the rendered
// text and skip code spans. Escaping could never have stopped those, because they read decoded
// text; the span is the mitigation the threat model names. The span is fenced with one more
// backtick than the longest run inside it, so a value cannot close its own span.
//
// usabl's own prose is escaped instead. Every character a renderer could read as the start of
// markup is written as a numeric character reference, which renders as exactly the character it
// names, so the report's own lines cannot be read as markup and still read as prose. The set
// includes the emphasis and code characters: a delimiter pair wrapped around a piece of text
// vanishes and leaves the piece behind, so "UNTRUSTED *TEXT*" renders as "UNTRUSTED TEXT", and a
// backslash hides before punctuation the same way. What is escaped is fixed text this file
// wrote, so the escape is defense in depth rather than the thing holding the line.
const MARKUP_SIGNIFICANT = /[&<>[\]`*_~\\|]/g;

// Block markup changes what a line is rather than what it says: a line that begins "#" renders
// as a heading, "-" as a list item, "---" alone as a rule or, under another line, a setext
// underline that turns that line into a heading. The escaped values above never start a line,
// but the rule is kept so escapeMarkdown stands on its own if that changes. The first character
// is written as a reference, after any leading spaces, because a renderer allows up to three
// spaces of indent before block markup.
const BLOCK_MARKER_AT_LINE_START = /^(\s*)([#\-+*=]|\d(?=\d*[.)]))/;

// A renderer turns "https://example.test/path" and "www.example.test" into links without being
// asked. Both are matched on the raw bytes, the "://" of a scheme and the "www." of a bare host,
// so a reference in place of the colon or the dot stops the link and still renders as the same
// character. Only a colon followed by "//" is touched, so a label like "why:" stays readable.
const SCHEME_COLON = /:(?=\/\/)/g;
const WWW_DOT = /(www)\./gi;

function reference(character: string): string {
  return `&#${character.codePointAt(0) ?? 0};`;
}


function escapeMarkdown(text: string): string {
  return text
    .replace(MARKUP_SIGNIFICANT, reference)
    .replace(SCHEME_COLON, reference)
    .replace(WWW_DOT, (_whole, www: string) => `${www}${reference('.')}`)
    .replace(
      BLOCK_MARKER_AT_LINE_START,
      (_whole, indent: string, marker: string) => `${indent}${reference(marker)}`,
    );
}

// The brackets a headline wraps its status and severity in.
//
// They are usabl's own punctuation, and they still go through the escape, as they did when a
// whole headline was escaped at once: the line renders exactly as it always did, and a pair of
// brackets can never be read as a reference-style link. Sealing the values is what holds the
// line now, so this is the escape's remaining job on this surface, and it stays because prose
// this file writes is the only thing that should ever reach it.
const OPEN_BRACKET = escapeMarkdown('[');
const CLOSE_BRACKET = escapeMarkdown(']');

/**
 * A count printed as a bare number, checked at the point of printing.
 *
 * Sealing by carrier holds for strings. It does not reach a number, and this surface reads a
 * document rather than a Result it built, so a field typed as a number is whatever the document
 * said, and it does not even have to be a field. A list shaped `{"length": "@user"}` is never
 * iterated by the coverage counts, so nothing throws and the text would land in a line as a
 * number.
 *
 * A number is printed only when it really is a whole number, and named otherwise. A code span
 * would seal it just as well, but a count is the one value a span makes harder to read, and a
 * whole number cannot be markup, a link, or a mention, so the check is the better seal here. The
 * check and the words for a failed check are shared with every other surface (../output/carried).
 */
const wholeNumber = wholeNumberText;

// A code span, fenced long enough that nothing inside it can end the span early. Character
// references are not interpreted inside a code span, so escaping is the wrong tool here: a value
// carrying a backtick has to be fenced away instead, or the rest of the line is read as markup.
//
// The value is rendered exactly, spaces included. CommonMark strips one space from each end of
// a span only when the content begins and ends with a space and is not all spaces, so a value
// that does both is padded by one space on each side and comes back whole; so is a value that
// begins or ends with a backtick, which the padding keeps off the fence. An empty value is
// written as a span holding one space, because two bare backticks are not a span at all.
function inlineCode(value: string): string {
  if (value.length === 0) {
    return '` `';
  }
  let longestRun = 0;
  let run = 0;
  for (const character of value) {
    run = character === '`' ? run + 1 : 0;
    longestRun = Math.max(longestRun, run);
  }
  const fence = '`'.repeat(longestRun + 1);
  const needsPadding =
    value.startsWith('`') ||
    value.endsWith('`') ||
    (value.startsWith(' ') && value.endsWith(' ') && value.trim().length > 0);
  const padding = needsPadding ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
}

// One line inside a frame: an engine-authored label and a page-derived value, and the length cap
// for that value. Every value is cut to its cap, so one oversized field can never push the
// comment past its size bound on its own.
interface FramedPiece {
  label: string;
  value: string;
  cap: TextCap;
}

// The framed block as Markdown lines: the opening marker, one line per piece, the closing marker.
//
// The two markers are engine text and the interface the overlay and the model match on, so they
// stay exactly as they are and sit outside the code spans, where they render as the visible seal.
// Each value is scrubbed here, the same scrub frameUntrustedBlock applies, so it cannot carry a
// marker and the only markers in the block are the two this function writes. A scrubbed value
// holds no line break, because the neutralizer folds separators to a space, so one piece is one
// line, and every line starts with its label. That matters twice: a line that starts with a
// label can never open a fenced code block, which a line starting with three backticks would,
// and no join of consecutive lines can produce the marker text.
function framedMarkdownLines(pieces: FramedPiece[]): string[] {
  return [UNTRUSTED_FRAME_START, ...pieces.map(framedLine), UNTRUSTED_FRAME_END];
}

// One line inside a frame: the label, then the value scrubbed, cut to its cap, and spanned.
function framedLine(piece: FramedPiece): string {
  return `${piece.label}: ${inlineCode(boundField(scrubString(piece.value), piece.cap))}`;
}

const HEADLINE: Record<Verdict, string> = {
  verified: 'VERIFIED',
  regression: 'REGRESSION',
  not_covered: 'NOT COVERED',
  approval_required: 'APPROVAL REQUIRED',
};

// A verdict this unit has no headline for is named, never printed. The document decides the
// verdict string, so the lookup can miss, and printing the miss put the word "undefined" where
// the verdict belongs.
function headlineFor(verdict: Verdict): string {
  return ownEntry(HEADLINE, verdict) ?? 'UNRECOGNIZED VERDICT';
}

function projectHeadline(verdict: Verdict): string {
  return `## usabl report: ${headlineFor(verdict)}`;
}

// A Result with no verdict is one of two opposite facts, and the shared verdict line tells them
// apart. Idle is exit 0 with nothing to check: no UI file changed, so there is nothing to report
// and the comment says only that. A failed run is exit 4: usabl proved nothing, and the comment
// says so with the engine's reason, sealed, because a crash summary carries a raw error message.
// Neither prints the sections a real verdict fills, since "none" under every heading reads as a
// clean run, and neither prints a receipt line, since a receipt exists only for a verified run
// and "run was not verified" would read as a run that was checked and failed. A null verdict
// with any other exit code can only be composed outside run(); it reads as no verdict with the
// reason, and never as idle, the same way the Stop hook reads it.
function renderNoVerdict(result: Result): string[] {
  const line = describeVerdict(result);
  if (result.exitCode === 0 && result.coverage.nothingToCheck) {
    return [COMMENT_MARKER, `## usabl report: ${formatVerdictWord(line)}`, '', line.meaning];
  }
  const failed = result.exitCode === 4;
  // Both words come from the shared verdict unit, which prints an exit code only when it really
  // is a whole number, so this heading carries no text the Result chose.
  const word = failed ? formatVerdictWord(line) : formatVerdictWord({ ...line, word: 'NO VERDICT' });
  const meaning = failed ? line.meaning : 'usabl did not reach a verdict for this change.';
  return [
    COMMENT_MARKER,
    `## usabl report: ${word}`,
    '',
    meaning,
    '',
    ...framedMarkdownLines([{ label: 'engine summary', value: result.summary, cap: 'summary' }]),
    ...renderJudge(result),
  ];
}

// One line saying the CI judge produced this Result. Disclosure only, never a verdict.
function renderJudge(result: Result): string[] {
  if (!isJudgeDisclosure(result.judge)) {
    return [];
  }
  return ['', `Judge: ${judgeLine(result.judge)}`];
}

function renderAccessibilitySplit(result: Result): string[] {
  if (result.verdict !== 'approval_required') {
    return [];
  }
  const accessibility =
    result.accessibilityVerdict === null ? 'IDLE' : headlineFor(result.accessibilityVerdict);
  return [
    '',
    `Policy changed. Accessibility on this run: **${accessibility}**. Merge still needs a CODEOWNERS user approval of this head from someone other than the pull request author.`,
  ];
}

function renderReceipt(result: Result): string[] {
  if (result.receipt === null) {
    // Receipts are verified-only evidence. Missing receipt must never look like a pass.
    return ['_No receipt: run was not verified._'];
  }
  return [
    '### Receipt',
    `- sourceTree: ${inlineCode(carriedWord(result.receipt.sourceTree, 'receipt'))}`,
    `- policyHash: ${inlineCode(carriedWord(result.receipt.policyHash, 'receipt'))}`,
    `- runnerVersion: ${inlineCode(carriedWord(result.receipt.runnerVersion, 'receipt'))}`,
    `- mintedAt: ${inlineCode(carriedWord(result.receipt.mintedAt, 'receipt'))}`,
  ];
}

function renderConformance(result: Result): string[] {
  // This is a read-only three-bucket projection and never a score.
  const summary = computeConformance(result);
  // Every count here is checked at the point of printing. The deterministic and judged counts are
  // computed from the findings this surface already walked, so they are numbers by construction;
  // the two not-evaluated counts are read straight off the lengths of two lists the document
  // supplied and are the ones that were reachable. All of them go through the same check, because
  // which counts are computed and which are read is not a property a reader of this line can see,
  // and the next count added here should not have to know the difference.
  const lines = [
    '### Conformance summary',
    `- schemaVersion: ${inlineCode(carriedWord(result.schemaVersion, 'receipt'))}`,
    // The headline is the count of what is listed below. The split follows in parentheses, and
    // only when there is something new, because "(0 failing, 0 unconfirmed)" on a clean run is
    // noise that teaches the reader to skip the clause on the runs where it carries something.
    `- deterministic: new ${wholeNumber(summary.deterministic.new)}${newSplit(summary)}, carried ${wholeNumber(summary.deterministic.carried)}, waived ${wholeNumber(summary.deterministic.waived)}, fixed ${wholeNumber(summary.deterministic.fixed)}`,
    `- judged: model-judgment ${wholeNumber(summary.judged.modelJudgment)}, preview ${wholeNumber(summary.judged.preview)}`,
    `- not evaluated: unresolved files ${wholeNumber(summary.notEvaluated.unresolvedFiles)}, gaps ${wholeNumber(summary.notEvaluated.gaps)}`,
    `- blocked: ${summary.blocked ? 'yes' : 'no'}`,
  ];
  // The count is carried by the Result, so it is printed only once it is really a whole number.
  // A count is the one kind of carried value a code span would make harder to read, and a whole
  // number cannot be a link, a mention, or markup of any kind.
  if (Number.isInteger(result.paidDownCount) && result.paidDownCount > 0) {
    lines.push(
      // An observation, not a conclusion: absence on a cleanly scanned screen is what a fixed
      // barrier looks like and also what a table rendering no rows looks like. The label carries
      // the noun, so the count needs no separate plural word.
      `- floor entries not observed this run: ${wholeNumber(result.paidDownCount)}` +
      ' (if they were fixed, run usabl floor prune to re-arm)',
    );
  }
  return lines;
}

// The source location and candidates as pieces for the untrusted frame. An app finding's source
// file can be read from a renderer-injected DOM attribute, so it is page-influenced and belongs
// inside the frame with the rest of the dynamic finding text. The frame scrubs each value, so
// these are passed raw rather than pre-neutralized.
function sourcePieces(
  source: DocsSourceMapping | undefined,
  appSource: AppSourceMapping | undefined,
): FramedPiece[] {
  if (source !== undefined && source.file !== null) {
    const pieces: FramedPiece[] = [{ label: 'source', value: formatDocsSourceLocation(source), cap: 'source' }];
    if (source.candidates.length > 1) {
      pieces.push({ label: 'candidates', value: source.candidates.join(', '), cap: 'candidates' });
    }
    return pieces;
  }
  if (appSource !== undefined && appSource.file !== null) {
    const pieces: FramedPiece[] = [{ label: 'source', value: formatAppSourceLocation(appSource), cap: 'source' }];
    if (appSource.candidates.length > 1) {
      pieces.push({ label: 'candidates', value: appSource.candidates.join(', '), cap: 'candidates' });
    }
    return pieces;
  }
  if (appSource !== undefined && appSource.candidates.length > 0) {
    return [{ label: 'candidates', value: appSource.candidates.join(', '), cap: 'candidates' }];
  }
  return [];
}

// One frame around every dynamic finding field, and every value in it in a code span. Where each
// value comes from decides that:
//
//   experience is page text. usabl builds it from the element's accessible name, or a scanner
//   describes the node, so it says whatever the page says.
//   why and fix are provider-authored for the built-in providers, but only five axe rules carry
//   a curated note; for every other rule both fall back to axe's failureSummary, whose check
//   messages quote attribute values from the page. So they are page-influenced and spanned.
//   source and candidates are path text. A docs mapping comes from the repository, but an app
//   mapping can be read from a renderer-injected DOM attribute, so a page can choose it. Spanned,
//   and a path reads well in a code span anyway.
//
// Only the engine-authored header (severity, screen id, layer, rule) stays outside the frame.
// That matches how the stop hook frames its block.
function findingPieces(finding: Finding): FramedPiece[] {
  return [
    { label: 'experience', value: finding.whatUserExperiences, cap: 'experience' },
    { label: 'why', value: finding.why, cap: 'why' },
    ...sourcePieces(finding.docsSource, finding.appSource),
    { label: 'fix', value: fixOrAbsence(finding), cap: 'fix' },
  ];
}

// One list item: the marker and first line, then every continuation line indented by the
// marker's content offset.
//
// CommonMark makes a continuation line part of the item only when it is indented to where the
// item's content starts, which is the marker plus the space after it: two columns for "- ",
// three for "1. ", four for "10. ". A continuation indented less than that leaves the item and
// renders as a paragraph outside the list, and a marker with nothing after it renders as an empty
// item. So the first line always goes on the marker's line, and the indent is computed from the
// marker text rather than written as a constant, so a two-digit index stays correct.
function listItem(marker: string, first: string, continuation: string[]): string[] {
  const indent = ' '.repeat(marker.length + 1);
  return [`${marker} ${first}`, ...continuation.map((line) => `${indent}${line}`)];
}

// A value the Result carried, printed in a code span on one of this comment's own lines, cut to
// its cap. A value that is not a string is named, never printed: this surface reads a document,
// so a field typed as a string can be anything.
function carriedWord(value: unknown, cap: TextCap): string {
  return typeof value === 'string' ? boundField(neutralize(value), cap) : 'unknown';
}

// ---- the size bound ----
//
// The comment is assembled as fixed lines and sections. Fixed lines are never cut: the marker,
// the verdict line, the approval line, the judge line, the receipt, the conformance counts, and
// the debt lines. Every value on them is a checked number, a fixed word, or a field cut to its
// cap, so together they come to a few thousand characters whatever the Result holds. A section
// holds items, and an item is one finding, gap, notice, note, or screen of announcements. The
// first coverage gap of each state is an item that is never cut either, so every state the run
// had stays named. There are at most five such items (four states and one for a state usabl does
// not recognize), each with its fields cut to their caps.
//
// When the whole body is over COMMENT_BODY_LIMIT, items are cut in CUT_ORDER, lowest priority
// first, and from the end of the comment within each tier. A cut item is removed whole, so no
// frame is ever opened without being closed. Each section that lost items says how many, and one
// note under the verdict says how many in all and where the full Result is.
//
// The order, lowest priority first:
//   1. announcements: current state from the transcript, not part of any verdict;
//   2. disclosed notes: what a check did not read, which never changes the verdict;
//   3. advisory findings: preview and model judgment never gate;
//   4. findings that do not gate: carried and waived findings the gate already accepted, and new
//      deterministic findings whose confidence is neither fail nor unverified, so they do not
//      block (in the collapsed view, a rule group whose representative does not gate);
//   5. notices for floored accessibility barriers this run did not see;
//   6. coverage gaps after the first one of each state;
//   7. the framed detail under a gating finding, which keeps its first line;
//   8. a gating finding's first line.
//
// Tier 8 is reached only when the first lines of the gating findings alone pass the bound. Each
// first line is cut to a few hundred characters, so at the default noise budget it never is: the
// noise budget collapses a long list into a handful of rule groups. It can be reached when an
// operator raises the noise budget far enough that hundreds of gating findings are listed one by
// one. The comment then keeps as many first lines as fit, in the order the gate ranked them, and
// says how many it left out. That is the one place a gating finding's first line is cut, because
// a body over GitHub's limit posts no comment at all.
const CUT_ORDER = [
  'announcement',
  'note',
  'advisory',
  'recorded',
  'floor-notice',
  'gap',
  'gating-detail',
  'gating',
] as const;
type CutTier = (typeof CUT_ORDER)[number];

// The tier of an item that is never cut. It is not in CUT_ORDER, so the cutter never reaches it.
const NEVER_CUT = 'never';
type ItemTier = CutTier | typeof NEVER_CUT;

// One entry in a section. `head` is the first line or lines and `detail` the rest. The whole item
// is cut at `tier`, or never when `tier` is NEVER_CUT. When `detailTier` is set, the detail alone
// is cut earlier, at that tier, and the head stays.
interface CommentItem {
  head: string[];
  detail: string[];
  tier: ItemTier;
  detailTier?: CutTier;
  cut: boolean;
  detailCut: boolean;
}

// What one item of a section is, and what more than one are, for the line that says how many were
// cut.
interface ItemNoun {
  one: string;
  many: string;
}

// A section: the lines before its items, the items, and the lines after them. `noun` names what
// one item is, for the line that says how many were cut.
// `close` is printed right after the items and before the cut count, so a section whose items sit
// inside one frame can close the frame there and the count stays outside it.
// `after` can depend on how many items were cut, for a line that counts what is shown.
interface CommentSection {
  kind: 'section';
  before: string[];
  items: CommentItem[];
  close: string[];
  after: string[] | ((cut: number) => string[]);
  noun: ItemNoun;
}

const FINDINGS: ItemNoun = { one: 'finding', many: 'findings' };
const GAPS: ItemNoun = { one: 'gap', many: 'gaps' };

type CommentPart = { kind: 'fixed'; lines: string[] } | { kind: 'cut-note' } | CommentSection;

function item(head: string[], detail: string[], tier: ItemTier, detailTier?: CutTier): CommentItem {
  return { head, detail, tier, ...(detailTier === undefined ? {} : { detailTier }), cut: false, detailCut: false };
}

function itemFrom(lines: string[], tier: CutTier, detailTier?: CutTier): CommentItem {
  const [first, ...rest] = lines;
  return item(first === undefined ? [] : [first], rest, tier, detailTier);
}

function section(
  before: string[],
  items: CommentItem[],
  after: CommentSection['after'],
  noun: ItemNoun,
  close: string[] = [],
): CommentSection {
  return { kind: 'section', before, items, close, after, noun };
}

function fixed(lines: string[]): CommentPart {
  return { kind: 'fixed', lines };
}

// The line under a section that lost items. `gating` counts the cut items that gate: when every
// cut item gates, the line says so, and when only some do, it says how many.
function cutLine(count: number, gating: number, noun: ItemNoun): string {
  const what = count === 1 ? noun.one : noun.many;
  const counted =
    gating === 0
      ? `${wholeNumber(count)} more ${what}`
      : gating === count
        ? `${wholeNumber(count)} more gating ${what}`
        : `${wholeNumber(count)} more ${what}, ${wholeNumber(gating)} of them gating,`;
  return `- ${counted} not shown here, to keep this comment under the size usabl posts.`;
}

function cutNote(cutItems: number, cutDetails: number): string {
  const items = `${wholeNumber(cutItems)} ${cutItems === 1 ? 'item is' : 'items are'} not shown`;
  const details =
    cutDetails === 0
      ? ''
      : `, and ${wholeNumber(cutDetails)} gating ${cutDetails === 1 ? 'finding shows' : 'findings show'} only ${cutDetails === 1 ? 'its' : 'their'} first line`;
  return `_This comment was shortened to stay under the size usabl posts, so ${items}${details}. Each section says what it left out. ${FULL_RESULT_POINTER}_`;
}

function renderParts(parts: CommentPart[]): string {
  const sections = parts.filter((part): part is CommentSection => part.kind === 'section');
  const cutItems = sections.reduce((total, part) => total + part.items.filter((entry) => entry.cut).length, 0);
  const cutDetails = sections.reduce(
    (total, part) => total + part.items.filter((entry) => !entry.cut && entry.detailCut).length,
    0,
  );
  const lines: string[] = [];
  for (const part of parts) {
    if (part.kind === 'fixed') {
      lines.push(...part.lines);
      continue;
    }
    if (part.kind === 'cut-note') {
      if (cutItems > 0 || cutDetails > 0) {
        lines.push('', cutNote(cutItems, cutDetails));
      }
      continue;
    }
    lines.push(...part.before);
    for (const entry of part.items) {
      if (!entry.cut) {
        lines.push(...entry.head, ...(entry.detailCut ? [] : entry.detail));
      }
    }
    lines.push(...part.close);
    const cutItemsHere = part.items.filter((entry) => entry.cut);
    const cut = cutItemsHere.length;
    if (cut > 0) {
      lines.push(cutLine(cut, cutItemsHere.filter((entry) => entry.tier === 'gating').length, part.noun));
    }
    lines.push(...(typeof part.after === 'function' ? part.after(cut) : part.after));
  }
  return lines.join('\n');
}

// The cut steps in order: for each tier in CUT_ORDER, from the end of the comment back, an item
// loses its detail or goes whole. Each call makes the next step and returns the characters it
// removed, or null when nothing is left to cut. The order is worked out once, so cutting a long
// comment is linear in its items.
function cutter(parts: CommentPart[]): () => number | null {
  const items = parts.flatMap((part) => (part.kind === 'section' ? part.items : []));
  const steps: Array<{ entry: CommentItem; detailOnly: boolean }> = [];
  for (const tier of CUT_ORDER) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const entry = items[index]!;
      if (entry.detailTier === tier && entry.detail.length > 0) {
        steps.push({ entry, detailOnly: true });
      }
      if (entry.tier === tier) {
        steps.push({ entry, detailOnly: false });
      }
    }
  }
  const size = (lines: string[]): number => lines.reduce((total, line) => total + line.length + 1, 0);
  let next = 0;
  return () => {
    while (next < steps.length) {
      const { entry, detailOnly } = steps[next]!;
      next += 1;
      if (entry.cut) {
        continue;
      }
      if (detailOnly) {
        entry.detailCut = true;
        return size(entry.detail);
      }
      entry.cut = true;
      return size(entry.head) + (entry.detailCut ? 0 : size(entry.detail));
    }
    return null;
  };
}

// The lines the cut adds back: one note under the verdict and one count line per section. Each is
// fixed wording around whole numbers, so this is an upper bound on what they can cost.
const CUT_LINES_RESERVE = 600;
const CUT_LINE_RESERVE = 140;

/**
 * Renders the parts within `limit` (COMMENT_BODY_LIMIT for the posted comment), counted with the
 * newline the CLI writes after the body. A body that fits is returned exactly as it was assembled.
 *
 * A first pass works on line lengths, so a comment with thousands of items is not rendered once
 * per cut, and reserves room for the lines the cut adds. A second pass renders and checks the
 * real body, and cuts further while it is over.
 */
function renderWithinLimit(parts: CommentPart[], limit: number): string {
  const fits = (text: string): boolean => text.length + 1 <= limit;
  const whole = renderParts(parts);
  if (fits(whole)) {
    return whole;
  }
  const cutOne = cutter(parts);
  const sections = parts.filter((part) => part.kind === 'section').length;
  let estimate = whole.length + 1 + CUT_LINES_RESERVE + sections * CUT_LINE_RESERVE;
  while (estimate > limit) {
    const removed = cutOne();
    if (removed === null) {
      break;
    }
    estimate -= removed;
  }
  let body = renderParts(parts);
  while (!fits(body) && cutOne() !== null) {
    body = renderParts(parts);
  }
  return body;
}

// ---- sections ----

// The known section holds two statuses, carried and waived, so each of its items names its own
// status beside the severity, in the one span the collapsed headline uses. The other sections hold
// one status each, which the heading already names.
function formatFinding(finding: Finding, withStatus: boolean): string[] {
  const rule = boundField(neutralize(finding.rule), 'rule');
  const layer = boundField(neutralize(finding.layer), 'word');
  const screenId = boundField(neutralize(finding.screenId), 'screenId');
  const severity = boundField(neutralize(finding.severity), 'word');
  const label = withStatus ? `${boundField(neutralize(finding.status), 'word')} ${severity}` : severity;
  return listItem(
    '-',
    `${OPEN_BRACKET}${inlineCode(label)}${CLOSE_BRACKET} ${inlineCode(screenId)} - ${inlineCode(`${layer}/${rule}`)}`,
    framedMarkdownLines(findingPieces(finding)),
  );
}

// A finding as an item. A gating finding keeps its first line until the very last tier; its frame
// goes earlier. Any other finding goes whole at its lane's tier.
function findingItem(finding: Finding, withStatus: boolean, tier: CutTier): CommentItem {
  const lines = formatFinding(finding, withStatus);
  return isBlockingBarrier(finding) ? itemFrom(lines, 'gating', 'gating-detail') : itemFrom(lines, tier);
}

function renderFindingGroup(
  title: string,
  findings: Finding[],
  tier: CutTier,
  withStatus = false,
): CommentSection {
  if (findings.length === 0) {
    return section([`### ${title}`], [], ['- none'], FINDINGS);
  }
  return section(
    [`### ${title}`],
    findings.map((finding) => findingItem(finding, withStatus, tier)),
    [],
    FINDINGS,
  );
}

// The headline is built from the group's fields rather than from one formatted string, so every
// field the Result carried can be sealed on its own: the screen id, which the router fallback
// derives from a route literal in the application, and the status, severity, layer, and rule,
// which arrive as whatever the document handed to `usabl comment` said. The brackets and the
// count are the only prose left on the line. The status and the severity share one span, so the
// line keeps the shape it had when it was one escaped string.
function formatCollapsedFinding(group: CollapsedFindingGroup): string[] {
  const finding = group.representative;
  const rule = boundField(neutralize(finding.rule), 'rule');
  const layer = boundField(neutralize(finding.layer), 'word');
  const screenId = boundField(neutralize(finding.screenId), 'screenId');
  const severity = boundField(neutralize(finding.severity), 'word');
  const status = boundField(neutralize(group.status), 'word');
  const count = formatCollapsedGroupCount(group);
  const headline = `${OPEN_BRACKET}${inlineCode(`${status} ${severity}`)}${CLOSE_BRACKET} ${inlineCode(screenId)}/${inlineCode(`${layer}/${rule}`)}${count}`;
  // The headline names the screen id, layer, rule, and severity, so the frame follows it directly.
  // A second line naming the same four values only repeated them. The frame lines are
  // continuations of the item, not a nested item, so they render inside this item.
  return listItem('-', headline, framedMarkdownLines(findingPieces(finding)));
}

function renderCollapsedFindings(findings: Finding[], config?: UsablConfig): CommentSection | null {
  // The collapsed list holds new findings and recorded debt. Only the findings the gate blocks on
  // are called gating, so the hint says "gating" only when every finding in it gates, and
  // otherwise names the deterministic total and then how many of them gate.
  const gatingCount = findings.filter(isBlockingBarrier).length;
  const recordedCount = findings.length - gatingCount;
  const noun = recordedCount === 0 ? 'gating findings' : 'deterministic findings';
  const view = applyNoiseBudget(findings, resolveNoiseBudgetDefault(config), noun);
  // Render the collapsed view whenever the shown groups do not map one to one to findings, whether
  // that is from grouping repeated rules or from the budget hiding groups. Checking only collapsed
  // dropped the grouped-but-not-truncated case back to a raw, hint-less list.
  if (!view.grouped && !view.collapsed) {
    return null;
  }
  return section(
    ['### Findings (collapsed by rule)'],
    view.groups.map((group) => {
      const lines = formatCollapsedFinding(group);
      return isBlockingBarrier(group.representative)
        ? itemFrom(lines, 'gating', 'gating-detail')
        : itemFrom(lines, 'recorded');
    }),
    // The hint counts the rule groups shown. When the size bound cut some, it is worked out again
    // from the groups still shown, so it never says more are shown than the comment holds.
    (cut) => [
      '',
      `_${
        cut === 0
          ? (view.showAllHint ?? '')
          : formatShowAllHint(
              {
                totalFindingCount: view.totalCount,
                shownGroupCount: view.groups.length - cut,
                totalGroupCount: view.totalGroupCount,
              },
              noun,
            )
      }_`,
      ...(recordedCount === 0
        ? []
        : [
            '',
            `_Of these, ${wholeNumber(gatingCount)} gate this run and ${wholeNumber(recordedCount)} are recorded debt that does not block it._`,
          ]),
    ],
    { one: 'rule group', many: 'rule groups' },
  );
}

// The floored barriers this run did not see on a screen it cannot show rendered, one notice per
// screen. Printed only when there is one, because the notice is about debt and a "none" under a
// heading nobody needs would teach readers to skip it. The sentence names a screen id, which can
// come from a route literal in the application, so it is framed with the other untrusted text.
// All notices share one frame. Each notice is one line in it, so the size bound can cut notices
// one at a time, and the frame closes before the line that counts what was cut.
function renderFloorUnconfirmed(result: Result): CommentSection | null {
  const screens = Array.isArray(result.floorUnconfirmed) ? result.floorUnconfirmed : [];
  if (screens.length === 0) {
    return null;
  }
  return section(
    ['### Recorded accessibility barriers not seen', UNTRUSTED_FRAME_START],
    screens.map((entry) =>
      item([framedLine({ label: 'notice', value: unconfirmedNotice(entry), cap: 'notice' })], [], 'floor-notice'),
    ),
    [''],
    { one: 'notice', many: 'notices' },
    [UNTRUSTED_FRAME_END],
  );
}

// What this change did to the accepted debt, and whether automatic tracking is on. Printed only
// when the floor holds debt or the change fixed some, because a line about no debt is noise. The
// sentences are this file's own prose and are escaped; the detail of an unreadable history is a
// value the Result carried, so it is written as a code span.
function renderDebt(result: Result): string[] {
  const debt: unknown = result.debt;
  if (typeof debt !== 'object' || debt === null) {
    return [];
  }
  const status = result.debt!;
  const line = debtSentence(status, 'This PR');
  const off = trackingOffSentence(status);
  if (line === null && off === null) {
    return [];
  }
  const detail =
    off !== null && typeof status.off?.detail === 'string'
      ? [`- detail: ${inlineCode(boundField(status.off.detail, 'gapReason'))}`]
      : [];
  return [
    '### Accessibility debt',
    ...(line === null ? [] : [escapeMarkdown(line)]),
    ...(off === null ? [] : ['', escapeMarkdown(off), ...detail]),
    '',
  ];
}

// The key a gap is counted under for the per-state cap. A state usabl does not recognize is
// counted under one fixed label and never under the text that arrived, the way the shared gap
// disclosure counts it.
const GAP_STATES: ReadonlySet<string> = new Set(['capability-denied', 'skipped', 'not-covered', 'unresolved']);
function gapStateKey(state: unknown): string {
  return typeof state === 'string' && GAP_STATES.has(state) ? state : UNRECOGNIZED_GAP_STATE;
}

function renderCoverageGaps(result: Result): CommentSection {
  if (!Array.isArray(result.coverage.gaps)) {
    return section(['### Coverage gaps', NOT_A_LIST], [], [], GAPS);
  }
  if (result.coverage.gaps.length === 0) {
    return section(['### Coverage gaps', '- none'], [], [], GAPS);
  }
  // At most GAPS_PER_STATE_CAP gaps of each state are named, in the order they arrived. The rest
  // of each state are counted on one line, so a change that touches hundreds of files no screen
  // owns names twenty of them and counts the others.
  const shownPerState = new Map<string, number>();
  const items: CommentItem[] = [];
  for (const gap of result.coverage.gaps) {
    const key = gapStateKey(gap.state);
    const shown = shownPerState.get(key) ?? 0;
    shownPerState.set(key, shown + 1);
    if (shown >= GAPS_PER_STATE_CAP) {
      continue;
    }
    // A gap ref can be a page URL, and a reason can carry a browser or provider exception, both
    // page- or tool-derived, so they are sealed as untrusted for the model reading this comment
    // and spanned so a URL in the ref cannot become a link the page chose. The state is an
    // engine enum and stays as the plain label.
    const framed = framedMarkdownLines([
      { label: 'ref', value: gap.ref, cap: 'gapRef' },
      { label: 'reason', value: gap.reason, cap: 'gapReason' },
    ]);
    // A state is an engine enum and no page can choose one, but `Result` is exported and a
    // caller can compose one outside the engine, so the label is any string at runtime. It
    // costs one code span to keep that out of the renderer's and the filters' reach.
    const lines = listItem('-', `(${inlineCode(carriedWord(gap.state, 'word'))})`, framed);
    // The first gap of each state is never cut, so every state present stays named.
    items.push(item(lines, [], shown === 0 ? NEVER_CUT : 'gap'));
  }
  const over = [...shownPerState.entries()]
    .filter(([, count]) => count > GAPS_PER_STATE_CAP)
    .map(([key, count]) => `- ${wholeNumber(count - GAPS_PER_STATE_CAP)} more ${inlineCode(key)} gaps are not shown.`);
  return section(
    ['### Coverage gaps'],
    items,
    over.length === 0 ? [] : [...over, `_${FULL_RESULT_POINTER}_`],
    GAPS,
  );
}

// The notes providers disclosed about screens, after the coverage gaps and under their own heading,
// so no reader takes one for a gap. A note never changes the verdict. The section is left out when
// no screen has a note. The ref and reason are framed like a gap's: engine words, but a caller can
// compose a Result outside the engine.
function renderNotes(result: Result): CommentSection | null {
  const notes = screenNotes(result);
  if (notes.length === 0) {
    return null;
  }
  return section(
    [
      '',
      '### Disclosed, does not block',
      '_What a check did not read on a screen. These are not coverage gaps and do not change the verdict._',
    ],
    notes.map((note) =>
      item(
        listItem(
          '-',
          `(${inlineCode(carriedWord(note.screenId, 'screenId'))})`,
          framedMarkdownLines([
            { label: 'ref', value: note.ref, cap: 'gapRef' },
            { label: 'reason', value: note.reason, cap: 'gapReason' },
          ]),
        ),
        [],
        'note',
      ),
    ),
    [],
    { one: 'note', many: 'notes' },
  );
}

// The announcement text for one stop, page-derived: tokens come from the accessibility tree and
// live regions, and the element-path fallback is a DOM selector. Returned raw; the caller frames
// it, and the frame scrubs it, so it is not pre-neutralized here.
function stopAnnouncementText(stop: TranscriptStop): string {
  const nonLiveTokens = stop.announcement
    .filter((token) => token.kind !== 'live' && token.text !== null)
    .map((token) => token.text ?? '');
  const liveTokens = stop.announcement
    .filter((token) => token.kind === 'live' && token.text !== null)
    .map((token) => `[announced] ${token.text ?? ''}`);
  const pieces = [...nonLiveTokens, ...liveTokens].filter((token) => token.length > 0);
  return pieces.length > 0 ? pieces.join(', ') : stop.elementPath;
}

// One item per screen: its heading and its stops. The size bound cuts a screen whole.
function renderAnnouncements(result: Result): CommentSection {
  const before = [
    '### Announcements (current run)',
    '_Screen reader announcements captured on this run. This is current state, not a before/after comparison against a base run._',
  ];
  const items: CommentItem[] = [];

  // Both lists are taken as lists only when they really are lists. The document supplies them,
  // and this section is where a length becomes a printed number and an index would become a list
  // marker. A list that is not a list contributes nothing rather than throwing part way through
  // an already assembled document.
  const screens = Array.isArray(result.screens) ? result.screens : [];
  for (const screen of screens) {
    const heading = `#### ${inlineCode(carriedWord(screen.screenId, 'screenId'))}`;
    if (!Array.isArray(screen.stops)) {
      items.push(item([heading, NOT_A_LIST], [], 'announcement'));
      continue;
    }
    const stops = screen.stops;
    if (stops.length === 0) {
      continue;
    }
    const lines = [heading];
    const capped = stops.slice(0, STOP_CAP);
    capped.forEach((stop, position) => {
      // The marker counts the stops this list prints and is never built from the stop's own
      // index. An index is carried by the Result, and text where a marker belongs is not a
      // marker: the line would leave the list and render as a paragraph beginning with whatever
      // the Result said, which is the one thing a code span cannot be used to stop, since a
      // marker has to be literal digits to work at all. Stops are printed in the order they
      // arrived, so the position says the same thing about any Result the engine wrote.
      //
      // The frame opens on the marker's line. A bare "1." renders as an empty item, and the
      // frame under it, indented two columns where "1. " needs three, would leave the list.
      const [first, ...rest] = framedMarkdownLines([
        { label: 'announced', value: stopAnnouncementText(stop), cap: 'announcement' },
      ]);
      lines.push(...listItem(`${position + 1}.`, first!, rest));
    });
    if (stops.length > STOP_CAP) {
      // Both numbers are real: the cap is this file's own constant, and the total is the length
      // of a list this function proved was a list.
      lines.push(`- showing first ${wholeNumber(STOP_CAP)} of ${wholeNumber(stops.length)} stops`);
    }
    items.push(item(lines, [], 'announcement'));
  }

  return section(before, items, items.length === 0 ? ['- none'] : [], { one: 'screen', many: 'screens' });
}

/** The failing and unconfirmed breakdown behind the new count, omitted when nothing is new. */
function newSplit(summary: ConformanceSummary): string {
  if (!Number.isInteger(summary.deterministic.new) || summary.deterministic.new <= 0) {
    return '';
  }
  return ` (${wholeNumber(summary.deterministic.newFailing)} failing, ${wholeNumber(summary.deterministic.newUnconfirmed)} unconfirmed)`;
}

export function projectPrComment(result: Result, config?: UsablConfig): string {
  return projectPrCommentWithin(result, config, COMMENT_BODY_LIMIT);
}

/**
 * The comment cut to another bound. Only tests call it, to walk the cut order step by step on a
 * small Result. The posted comment always uses COMMENT_BODY_LIMIT, through projectPrComment.
 */
export function projectPrCommentWithin(result: Result, config: UsablConfig | undefined, limit: number): string {
  // Scrub first because PR comments are public egress for page-derived text, and for the query
  // and the fragment of a configured screen url.
  const safe = scrubPublishedResult(result);
  if (safe.verdict === null) {
    // Every value here is cut to its cap, so this body is a few hundred characters long.
    return renderNoVerdict(safe).join('\n');
  }
  const deterministicNew = safe.findings.filter(
    (finding) => finding.evidenceClass === 'deterministic' && finding.status === 'new',
  );
  // Recorded debt is what the gate already accepted: carried against the evidence floor, or
  // waived. Both are listed, the way the terminal and the overlay list them. A waived finding was
  // once in no lane at all, because the lanes were new, carried, and advisory, so it vanished
  // from this comment while the other surfaces showed it. Fixed findings are not listed here, as
  // they are not in the terminal report, because this run did not observe them. The overlay does
  // list them, and this comment counts them on the conformance summary's deterministic line.
  const deterministicRecorded = safe.findings.filter(
    (finding) =>
      finding.evidenceClass === 'deterministic' &&
      (finding.status === 'carried' || finding.status === 'waived'),
  );
  const advisory = safe.findings.filter(
    (finding) => finding.evidenceClass === 'preview' || finding.evidenceClass === 'model-judgment',
  );
  // Collapse only the deterministic lane. Advisory findings never gate, so they keep their own
  // labeled section and are never mixed into the collapsed barrier list. Each collapsed group
  // names its status, so recorded debt in it still reads as recorded.
  const deterministic = [...deterministicNew, ...deterministicRecorded];
  const collapsedGating = renderCollapsedFindings(deterministic, config);
  const blank = fixed(['']);
  const findingSections: CommentPart[] =
    collapsedGating !== null
      ? [collapsedGating, blank, renderFindingGroup('Advisory (non-gating)', advisory, 'advisory')]
      : [
          renderFindingGroup('New accessibility barriers', deterministicNew, 'recorded'),
          blank,
          renderFindingGroup('Known (recorded debt)', deterministicRecorded, 'recorded', true),
          blank,
          renderFindingGroup('Advisory (non-gating)', advisory, 'advisory'),
        ];
  const optional = (part: CommentSection | null): CommentPart[] => (part === null ? [] : [part]);

  // Every section is printed for a real verdict, "none" included: under a real verdict an empty
  // section is a fact about the run, where under no verdict it would read as a clean one.
  return renderWithinLimit([
    fixed([COMMENT_MARKER, projectHeadline(safe.verdict), ...renderAccessibilitySplit(safe), ...renderJudge(safe)]),
    { kind: 'cut-note' },
    fixed(['', ...renderReceipt(safe), '', ...renderConformance(safe), '', ...renderDebt(safe)]),
    ...findingSections,
    blank,
    ...optional(renderFloorUnconfirmed(safe)),
    renderCoverageGaps(safe),
    ...optional(renderNotes(safe)),
    blank,
    renderAnnouncements(safe),
  ], limit);
}
