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
import { describeIdProblem } from './id-grammar.js';

/**
 * Returns why an id cannot be trusted as an identity, or null when it can.
 *
 * The rule is the shared id grammar and nothing else. The text never repeats the id: a refused
 * character is named by position and code point, and the field label names the id.
 */
export function describeRequirementIdProblem(id: string): string | null {
  return describeIdProblem(id);
}

/** Where one requirement id was declared: the file, and the position in that file's list. */
export interface RequirementIdSite {
  id: string;
  path: string;
  index: number;
}

/**
 * Builds the duplicate message through the config error template so the id and both paths are
 * scrubbed by construction. The id has already passed the grammar by the time it can repeat, so
 * every character in it renders; the paths are operator-authored file names that reach a
 * terminal, and scrubbing them is what keeps a control sequence in a file name out of the log.
 * The template builds an Error because that is the shape every config message shares; only its
 * text is used here, because the loader returns failures rather than throwing them.
 */
function duplicateReason(first: RequirementIdSite, repeat: RequirementIdSite): string {
  const where =
    first.path === repeat.path
      ? configError`It is declared at requirements[${first.index}] and again at requirements[${repeat.index}] in ${repeat.path}.`
      : configError`It is declared at requirements[${repeat.index}] in ${repeat.path} and already at requirements[${first.index}] in ${first.path}.`;
  return configError`duplicate requirement id "${repeat.id}". ${where.message} Both requirements become the rule intake:${repeat.id}, and a waiver matches on the rule and the surface, so one waiver would cover a requirement its author never saw. Give each requirement its own id.`
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
  const firstSeen = new Map<string, RequirementIdSite>();

  for (const site of sites) {
    const first = firstSeen.get(site.id);
    if (first !== undefined) {
      return { path: site.path, reason: duplicateReason(first, site) };
    }
    firstSeen.set(site.id, site);
  }

  return null;
}
