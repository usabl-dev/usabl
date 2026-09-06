/**
 * Identity rules for requirement ids.
 *
 * A requirement id is a waiver identity. Every requirement becomes the rule `intake:<id>`, and a
 * waiver matches on that rule plus the surface. Two rules that read as one therefore let a single
 * waiver stand in for a requirement its author never saw, and a real unwaived barrier reports as
 * a clean run.
 *
 * That can happen two ways, so this unit closes both.
 * Ids that are equal: one waiver covers both requirements outright.
 * Ids that only look equal: the engine keeps them apart, but the person writing the waiver and
 * the person reading the report cannot, so the accountability the waiver records is guesswork.
 *
 * The character rule is the shared id grammar, the same one surface ids use, so one product has
 * one answer to what an id may contain. This unit turns that grammar's result into a message and
 * adds the uniqueness check that needs every requirement file at once. It returns rather than
 * throws throughout, because intake is policy input and a bad bundle is an approval_required
 * disclosure, not an engine crash. It must never rewrite an id or decide a verdict.
 */
import { configError } from './config-error.js';
import { codePointLabel, validateId } from './id-grammar.js';

/**
 * Returns why an id cannot be trusted as an identity, or null when it can.
 *
 * A refused character is reported by position and code point and is never printed back, because
 * every character the grammar refuses is either invisible or reorders its neighbours, so printing
 * it would show the operator nothing or something other than what the file holds. The id itself
 * is not repeated either: the message names the field, and the field names the id.
 */
export function describeRequirementIdProblem(id: string): string | null {
  const result = validateId(id);
  if (result.ok) {
    return null;
  }

  switch (result.problem) {
    case 'empty':
      return 'id is required';
    case 'disallowed-character':
      // The position counts characters from one, which is how a person reading the file counts.
      return (
        `contains a character that is not allowed, at position ${result.index + 1}: ` +
        `${codePointLabel(result.codePoint)}. Requirement ids are matched exactly and are read by ` +
        'the people who approve waivers, so every character in an id has to be visible. ' +
        'Remove it.'
      );
    case 'not-nfc':
      // A base letter plus a combining mark prints the same as the single composed character.
      // Both forms are valid text; only one of them can be the id, or two ids print alike.
      return (
        'is not in Unicode NFC form, so it can print exactly like a different id while matching ' +
        'separately. Save the id in NFC form.'
      );
  }
}

/** Where one requirement id was declared. */
export interface RequirementIdSite {
  id: string;
  path: string;
}

/**
 * Builds the duplicate message through the config error template so the id and both paths are
 * scrubbed by construction. The id has already passed the grammar by the time it can repeat, so
 * every character in it renders; the paths are operator-authored file names that reach a
 * terminal, and scrubbing them is what keeps a control sequence in a file name out of the log.
 * The template builds an Error because that is the shape every config message shares; only its
 * text is used here, because the loader returns failures rather than throwing them.
 */
function duplicateReason(id: string, firstPath: string, repeatPath: string): string {
  if (firstPath === repeatPath) {
    return configError`duplicate requirement id "${id}". It is declared more than once in ${repeatPath}. Both requirements become the rule intake:${id}, and a waiver matches on the rule and the surface, so one waiver would cover a requirement its author never saw. Give each requirement its own id.`
      .message;
  }
  return configError`duplicate requirement id "${id}". It is declared in ${repeatPath} and already in ${firstPath}. Both requirements become the rule intake:${id}, and a waiver matches on the rule and the surface, so one waiver would cover a requirement its author never saw. Give each requirement its own id.`
    .message;
}

/**
 * Reports the first repeated id across every site in the bundle, or null when all are distinct.
 *
 * Comparison is exact, the same comparison waiver matching makes. Callers build the whole failure
 * from the returned site so the operator gets both files, not just the second one.
 */
export function findDuplicateRequirementId(
  sites: readonly RequirementIdSite[],
): { path: string; reason: string } | null {
  const firstSeenAt = new Map<string, string>();

  for (const site of sites) {
    const firstPath = firstSeenAt.get(site.id);
    if (firstPath !== undefined) {
      return { path: site.path, reason: duplicateReason(site.id, firstPath, site.path) };
    }
    firstSeenAt.set(site.id, site.path);
  }

  return null;
}
