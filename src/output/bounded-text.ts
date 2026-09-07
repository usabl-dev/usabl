/**
 * Length bounds for the text fields a surface prints, and for the whole agent-facing message.
 *
 * The surfaces bound how many entries they print: the noise budget caps rule groups and the gap
 * disclosure caps entries per state. Neither bounds the length of one entry. A provider error
 * carrying a whole stack trace, or a page string a scanner echoed back, can arrive as one field
 * and, on a model-facing surface, consume the model's context on its own. This unit caps each
 * field and says so in the text, so a shortened field is visible and never silent. It then caps
 * the assembled message as a whole, dropping whole lines from the end and saying how many, so
 * the total is a proven bound and not a measured one.
 *
 * Only free text is bounded. A verdict word, an exit code, and a count are never shortened: the
 * surfaces print those from their own trusted scaffold and never pass them through here.
 *
 * Bounding a field cuts text and appends a note. Bounding a message removes whole lines. Neither
 * ever cuts inside a frame marker, because the surfaces frame after bounding fields, and the
 * message bound removes whole framed pieces before the frame is built.
 */

/**
 * Caps per field, in UTF-16 code units, with the reason for each.
 *
 * The caps are sized to the text that carries meaning at the start of each field. A cap that is
 * too small hides the cause; one that is too large defeats the bound.
 */
export const TEXT_CAPS = {
  // The gate writes a short summary with counts first. Only a crash summary carries an error
  // message, and the first few hundred characters of one name the failure.
  summary: 400,
  // What a user experiences is one or two sentences from usabl or from a scanner's description.
  experience: 400,
  // A fix is a curated note or a scanner's failure summary, which can list several options.
  fix: 600,
  // A rule id is a short slug. Anything longer is not a rule id and the start still names it.
  rule: 80,
  // A screen id comes from operator config and is a short slug.
  screenId: 80,
  // A layer name is one word.
  layer: 40,
  // A gap ref is a file path or a URL. A URL carrying a long query string is still named by
  // its origin and path, which come first.
  gapRef: 200,
  // A gap reason is usabl's own sentence or a provider error. A stack trace names its cause in
  // the first lines.
  gapReason: 400,
  // A source location is a file path with a line, or a path with a markup fragment.
  source: 300,
  // The joined candidate list. Each candidate is a path; a long list still names the first few.
  candidates: 500,
  // A receipt source tree is a git object id, forty hex characters. Twice that is generous.
  receipt: 80,
} as const;

export type TextCap = keyof typeof TEXT_CAPS;

/**
 * The whole stop-hook message, in UTF-16 code units. A few thousand tokens for a model reader.
 *
 * Sized from the caps so that at the default noise budget the message fits with every field
 * oversized and nothing is dropped; the bound exists for an operator-raised budget and for
 * anything not foreseen. The default worst case is a guarded-file block that also found
 * barriers: five rule groups and five gap entries (four states plus one unrecognized), every
 * free-text field over its cap and carrying a note of about forty characters, and a long list of
 * guarded paths. Opening lines: about 125 for the verdict, 170 for the next step, and about 950
 * for the guarded-file lines (the label, the path list at the candidates cap with its note, and
 * the two fixed sentences). Five headlines at about 225 each and the hint: about 1,200. Inside
 * the frame: the summary about 455; per group a barrier label about 130, screen about 250,
 * experience about 575, fix about 770, so about 8,600 for five; the Not evaluated label and five
 * gap entries at about 740: about 3,700. Frame markers 83. That sums to about 15,300; 16,500
 * leaves room for longer omission counts and labels. A regression block, which has no
 * guarded-file lines and a shorter step, comes to about 14,100.
 */
export const AGENT_MESSAGE_BUDGET = 16_500;

/**
 * The whole self-check message. The self-check prints everything the stop hook prints, minus
 * the next step, plus an advisory line, a meaning line, and one source or candidates piece per
 * group, which is about 680 more per group at the candidates cap, so about 3,400 more at five
 * groups: about 18,500 in the same worst case. 20,000 keeps the same margin as the stop hook.
 */
export const SELF_CHECK_MESSAGE_BUDGET = 20_000;

// What a page-supplied copy of the note is replaced with, so only this unit can emit the real
// one. Substitution rather than escaping, for the same reason the frame markers are substituted:
// the reader is a language model, and an escaped marker still reads as the marker.
const REMOVED_NOTE = '[REDACTED SHORTENED MARKER';

// The characters a reader cannot see. A note with one of these planted between two of its letters
// renders exactly like the real note, so the match looks through them. The set is the one the
// frame-marker scrub uses: Unicode's default-ignorable code points (joiners, variation selectors,
// the tag block), the direction controls, the C0 and C1 controls, and the two line separators.
// Taken from Unicode properties rather than a list, because a list falls behind each release.
const LOOK_THROUGH = '[\\p{Default_Ignorable_Code_Point}\\p{Bidi_Control}\\p{Cc}\\u2028\\u2029]*';

// Both real notes open with this word. Built from the literal so the pattern and the note cannot
// drift apart: each character of the word may be preceded by any run of look-through characters.
const NOTE_WORD = '[shortened';
const FORGED_NOTE = new RegExp(
  Array.from(NOTE_WORD, (char) => `${LOOK_THROUGH}${char === '[' ? '\\[' : char}`).join('').replace(/^.*?\\\[/u, '\\['),
  'giu',
);

/**
 * Replaces a page-supplied shortened note so it cannot pass for a real one.
 *
 * Runs on every field before it is bounded, so the only real note in the output is the one
 * appended here. Applied whether or not the field is over its cap: a forged note under the cap
 * is the case that matters. The whole matched span goes, invisible characters included, so the
 * replacement is one clean literal and nothing planted inside the word survives to rejoin it.
 *
 * Callers scrub first. A note split by a NUL or an escape sequence is the neutralizer's job, and
 * it rejoins the halves before this runs; this then catches what the neutralizer keeps on
 * purpose, the characters that carry meaning in real text but draw nothing.
 */
export function removeForgedNotes(text: string): string {
  return text.replace(FORGED_NOTE, REMOVED_NOTE);
}

/**
 * Returns `text`, with any forged note replaced, unchanged when it fits, or its first `max`
 * code units followed by a note that names how many were omitted. The cut never lands between
 * the two halves of a surrogate pair, so a shortened string is still valid text.
 */
export function boundText(text: string, max: number): string {
  const clean = removeForgedNotes(text);
  if (clean.length <= max) {
    return clean;
  }
  let keep = max;
  const last = clean.charCodeAt(keep - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    keep -= 1;
  }
  const omitted = clean.length - keep;
  return `${clean.slice(0, keep)} [shortened, ${omitted} characters omitted]`;
}

/** `boundText` with the cap for a named field. */
export function boundField(text: string, field: TextCap): string {
  return boundText(text, TEXT_CAPS[field]);
}

export interface BoundedMessageInput {
  // Trusted lines printed before the frame. The first `keep` of them are never dropped: the
  // verdict line, the summary, and the next step, each already bounded per field.
  scaffold: string[];
  keep: number;
  // Free-text pieces that go inside one frame, each already bounded per field.
  pieces: string[];
  // The first `keepPieces` pieces are never dropped. Surfaces open the frame with the gate's
  // summary and keep it, so a reader always learns what the gate said. Defaults to none.
  keepPieces?: number;
  // Builds the single frame around the pieces. Called with the pieces that survive.
  frame: (pieces: string[]) => string;
  budget?: number;
}

function noteFor(omitted: number): string {
  return `[shortened to fit the message budget, ${omitted} line(s) omitted; run usabl check --json for the full list]`;
}

/**
 * Assembles scaffold, frame, and a closing note so the whole message fits the budget.
 *
 * A message that fits is returned as it is. Otherwise whole lines are dropped from the end,
 * framed pieces first and trailing scaffold lines after, until the message fits. The first
 * `keep` scaffold lines and the first `keepPieces` pieces are never dropped. The frame is
 * rebuilt from the surviving pieces, so it always opens once and closes once and no piece is
 * ever cut. When anything is dropped, the last line says how many lines went and where to find
 * them.
 *
 * One edge is not enforced: when the kept lines alone exceed the budget, they are returned
 * whole and the message is over budget. Every surface caps the free text in those lines and the
 * rest of each is fixed wording, so at the production budget this cannot happen; a test holds
 * the edge so a change to either side is noticed. The stop hook decides `block` before it builds
 * the message, so even there the decision is unaffected.
 */
export function assembleBoundedMessage(input: BoundedMessageInput): string {
  const budget = input.budget ?? AGENT_MESSAGE_BUDGET;
  const keepPieces = input.keepPieces ?? 0;
  const scaffold = [...input.scaffold];
  const pieces = [...input.pieces];
  let omitted = 0;

  const render = (): string => {
    const lines = [...scaffold];
    if (pieces.length > 0) {
      lines.push(input.frame(pieces));
    }
    if (omitted > 0) {
      lines.push(noteFor(omitted));
    }
    return lines.join('\n');
  };

  // A message that fits keeps every line. The note is reserved only once a drop is certain.
  const whole = render();
  if (whole.length <= budget) {
    return whole;
  }

  const canDrop = (): boolean => pieces.length > keepPieces || scaffold.length > input.keep;
  const drop = (): string => (pieces.length > keepPieces ? pieces.pop()! : scaffold.pop()!);

  // First pass on line lengths alone, so the frame is not rebuilt once per dropped line. Each
  // line costs its length plus a newline, the frame costs its two markers, and the note costs
  // its longest form. This over-counts by a few characters, so it never stops short.
  const lengthOf = (lines: string[]): number => lines.reduce((total, line) => total + line.length + 1, 0);
  const frameCost = pieces.length > 0 ? input.frame([]).length + 1 : 0;
  let estimate = lengthOf(scaffold) + lengthOf(pieces) + frameCost + noteFor(pieces.length + scaffold.length).length + 1;
  while (estimate > budget && canDrop()) {
    estimate -= drop().length + 1;
    omitted += 1;
  }

  // Second pass on the rendered message. The frame scrubs each piece, which can lengthen one
  // (a redaction marker is longer than a short secret), so the estimate can still be low.
  let message = render();
  while (message.length > budget && canDrop()) {
    drop();
    omitted += 1;
    message = render();
  }
  return message;
}
