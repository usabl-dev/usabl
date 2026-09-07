/**
 * One egress point for error text that quotes operator-authored config.
 *
 * Config parsing runs before a Result exists, so none of this passes through scrubResult on the
 * way out. A parse error goes straight to stderr and, through the stop hook, to a model. Branch
 * config is not trusted until the guard has checked it, so any value read out of one is untrusted
 * text arriving at a terminal.
 *
 * `configError` is a tagged template so the scrubbing cannot be forgotten: every interpolated
 * value is scrubbed by construction, and a message added later gets the same treatment without
 * anyone remembering to ask for it. It formats text only. It must never decide a verdict.
 */
import { scrubString } from '../surfaces/scrub.js';

// Caps how much of one operator string a message repeats back, so a very long value cannot bury
// the sentence that explains what to fix.
const OPERATOR_TEXT_LIMIT = 120;

/**
 * Prepares one operator-authored value to be quoted in a message.
 *
 * Reuses the surface scrubber rather than a second one, so control sequences, forged
 * untrusted-text frame markers, and credential-shaped values come out here the same way they come
 * out of page text.
 */
export function operatorText(value: unknown): string {
  const scrubbed = scrubString(String(value));
  const characters = [...scrubbed];
  if (characters.length <= OPERATOR_TEXT_LIMIT) {
    return scrubbed;
  }
  return `${characters.slice(0, OPERATOR_TEXT_LIMIT).join('')} (truncated)`;
}

/**
 * Prepares an operator-authored file path to be quoted in a message.
 *
 * The scrubber removes a whole terminal control sequence, payload included, so a file named
 * "ok<ESC>]0;title<BEL>.yaml" would print as "ok.yaml" and read as the same file as a clean one.
 * Each control character is first replaced by its visible code point label, which is plain
 * ASCII, so the sequence is inert and the two names stay distinguishable. The rest of the
 * scrubbing still applies through the caller.
 */
export function operatorPath(path: string): string {
  let out = '';
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    out += isControl ? `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>` : character;
  }
  return out;
}

/**
 * Builds a config error whose interpolated values are all scrubbed.
 *
 * Use it for every message that quotes anything read out of a config or manifest file, including
 * field labels, since a label can carry an operator-chosen key.
 */
export function configError(strings: TemplateStringsArray, ...values: unknown[]): Error {
  let text = strings[0] ?? '';
  for (let index = 0; index < values.length; index += 1) {
    text += operatorText(values[index]);
    text += strings[index + 1] ?? '';
  }
  return new Error(text);
}
