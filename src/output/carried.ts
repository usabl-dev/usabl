/**
 * Type checks for values a Result carries, shared by every surface that prints one.
 *
 * The rule on every surface is by carrier, not by author: a value the Result carried is either
 * sealed or type-checked before it is printed. A surface seals strings its own way, in a code span
 * on the pull request comment and inside the untrusted frame on the two surfaces a language model
 * reads. Some values read better as the surface's own text, a count or a known enum word, and a
 * value of that kind cannot be markup, a link, a mention, or an instruction once it has been
 * checked. This unit holds those checks, so no surface writes a second version of them.
 *
 * `Result` is exported and can be composed outside the engine or parsed from a document, so at
 * runtime a field typed as a number or an enum can be anything. A value that fails its check is
 * named with a fixed word and never printed.
 *
 * This unit formats text only. It must never decide a verdict.
 */

/** What a value is called when it is not the type the contract says it is. */
export const UNKNOWN_VALUE = 'unknown';

/**
 * What a section says when the field it lists is not a list. Saying "none" there would be a claim
 * about the run, and a document that did not carry a list said nothing about the run.
 */
export const NOT_A_LIST = '- unreadable: this Result did not carry a list here';

/** A count as text when it really is a whole number, and the word for one that is not. */
export function wholeNumberText(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) ? String(value) : UNKNOWN_VALUE;
}

/**
 * The entry a table holds for a carried key, or undefined when the table has none of its own. A
 * plain lookup also finds what every object inherits, so a key such as "toString" would return a
 * function and print its source where a word belongs.
 */
export function ownEntry<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** An enum value as text when it is one of the words given, and the word for one that is not. */
export function knownWordText(value: unknown, words: readonly string[]): string {
  return typeof value === 'string' && words.includes(value) ? value : UNKNOWN_VALUE;
}

/** The finding statuses, in the contract's words. */
export const FINDING_STATUSES: readonly string[] = ['new', 'carried', 'fixed', 'waived'];

/** The finding severities, in the contract's words. */
export const FINDING_SEVERITIES: readonly string[] = ['critical', 'serious', 'moderate', 'minor'];
