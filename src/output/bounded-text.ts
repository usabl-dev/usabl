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
 * The whole agent-facing message, in UTF-16 code units. A few thousand tokens for a model
 * reader. At the default noise budget the message fits with every field oversized and nothing
 * is dropped; the bound exists for an operator-raised budget and for anything not foreseen.
 */
export const AGENT_MESSAGE_BUDGET = 13_000;

// What a page-supplied copy of the note is replaced with, so only this unit can emit the real
// one. Substitution rather than escaping, for the same reason the frame markers are substituted:
// the reader is a language model, and an escaped marker still reads as the marker.
const FORGED_NOTE = /\[shortened\b/giu;
const REMOVED_NOTE = '[REDACTED SHORTENED MARKER';

/**
 * Replaces a page-supplied shortened note so it cannot pass for a real one.
 *
 * Runs on every field before it is bounded, so the only real note in the output is the one
 * appended here. Applied whether or not the field is over its cap: a forged note under the cap
 * is the case that matters.
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
  // Page-derived pieces that go inside one frame, each already bounded per field.
  pieces: string[];
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
 * Whole lines are dropped from the end, framed pieces first and trailing scaffold lines after,
 * until the message fits. The first `keep` scaffold lines are never dropped, and each of them is
 * bounded per field, so the result is a proven bound as long as those lines plus the note fit,
 * which they do by a wide margin. The frame is rebuilt from the surviving pieces, so it always
 * opens once and closes once and no piece is ever cut. When anything is dropped, the last line
 * says how many lines went and where to find them.
 */
export function assembleBoundedMessage(input: BoundedMessageInput): string {
  const budget = input.budget ?? AGENT_MESSAGE_BUDGET;
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

  const canDrop = (): boolean => pieces.length > 0 || scaffold.length > input.keep;
  const drop = (): string => (pieces.length > 0 ? pieces.pop()! : scaffold.pop()!);

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
