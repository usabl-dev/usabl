/**
 * Length bounds for the text fields a surface prints.
 *
 * The surfaces bound how many entries they print: the noise budget caps rule groups and the gap
 * disclosure caps entries per state. Neither bounds the length of one entry. A provider error
 * carrying a whole stack trace, or a page string a scanner echoed back, can arrive as one field
 * and, on a model-facing surface, consume the model's context on its own. This unit caps each
 * field and says so in the text, so a shortened field is visible and never silent.
 *
 * Only free text is bounded. A verdict word, an exit code, and a count are never shortened: the
 * surfaces print those from their own trusted scaffold and never pass them through here.
 *
 * Bounding cuts text and appends a note. It never removes a frame marker, because the surfaces
 * frame after bounding, and it never assembles a block that is then cut to fit.
 */

/**
 * Caps per field, in UTF-16 code units, with the reason for each.
 *
 * The caps are sized to the text that carries meaning at the start of each field. A cap that is
 * too small hides the cause; one that is too large defeats the bound. With the default noise
 * budget of five rule groups and the four gap states plus one unrecognized entry, the whole
 * stop-hook message stays under 13,000 characters at these caps even when every field is
 * oversized, which is a few thousand tokens for a model reader. The test for the stop hook
 * holds that number.
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
} as const;

export type TextCap = keyof typeof TEXT_CAPS;

/**
 * Returns `text` unchanged when it fits, or its first `max` code units followed by a note that
 * names how many were omitted. The cut never lands between the two halves of a surrogate pair,
 * so a shortened string is still valid text.
 */
export function boundText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let keep = max;
  const last = text.charCodeAt(keep - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    keep -= 1;
  }
  const omitted = text.length - keep;
  return `${text.slice(0, keep)} [shortened, ${omitted} characters omitted]`;
}

/** `boundText` with the cap for a named field. */
export function boundField(text: string, field: TextCap): string {
  return boundText(text, TEXT_CAPS[field]);
}
