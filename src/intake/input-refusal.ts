/**
 * The typed refusal for input that crosses a boundary into usabl: a file the engine reads, a
 * document on standard input, or a value a library caller passes to an exported function.
 *
 * `field` is the path of the refused value, with its position, for example
 * `floor.entries[2].screenId`. The message names the same path and says what is wrong. Neither
 * ever repeats the refused value. An id the grammar refuses is invisible or reorders the text
 * around it, and a document on standard input can carry text written to be rendered as a link or
 * a mention, so printing either back would show the reader something other than what was there.
 *
 * This unit describes a refusal. It must never decide a verdict or what a caller does next.
 */
import { describeIdProblem } from './id-grammar.js';

export class InputRefusedError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InputRefusedError';
    this.field = field;
  }
}

/**
 * Refuses a value that is not an id the shared id grammar accepts.
 *
 * `source` says whose input this is, for example "gate() input", so the message tells a reader
 * which call or file to fix. The message carries the grammar's own reason, which names a refused
 * character by position and code point and never prints the id.
 */
export function assertIdField(source: string, field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new InputRefusedError(field, `${source} ${field} must be a string id.`);
  }
  const problem = describeIdProblem(value);
  if (problem !== null) {
    throw new InputRefusedError(field, `${source} ${field} ${problem}`);
  }
}
