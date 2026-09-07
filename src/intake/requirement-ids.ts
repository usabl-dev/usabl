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
import { configError, operatorPath } from './config-error.js';
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

// The longest a file path is printed in a duplicate reason. Each interpolated value is capped by
// the config error template on its own, so a path is bounded here, before interpolation, and each
// path is interpolated as its own value. That way a long first path can never push the second
// location past the cap and out of the message.
const PATH_TEXT_LIMIT = 72;

/**
 * Shortens a path from the middle, keeping its start and its file name, with a visible marker
 * where characters were removed. Control characters are shown as code point labels first, so a
 * file name that carried a control sequence still reads as a different file from a clean one.
 */
function boundedPath(path: string): string {
  const characters = [...operatorPath(path)];
  if (characters.length <= PATH_TEXT_LIMIT) {
    return characters.join('');
  }
  const marker = '...';
  const keep = PATH_TEXT_LIMIT - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${characters.slice(0, head).join('')}${marker}${characters.slice(characters.length - tail).join('')}`;
}

/**
 * Builds the duplicate message through the config error template so the id and both paths are
 * scrubbed by construction. The id has already passed the grammar by the time it can repeat, so
 * every character in it renders; the paths are operator-authored file names that reach a
 * terminal, and scrubbing them is what keeps a control sequence in a file name out of the log.
 * Both locations are interpolated as separate values so both always survive the per-value cap.
 * The template builds an Error because that is the shape every config message shares; only its
 * text is used here, because the loader returns failures rather than throwing them.
 */
function duplicateReason(first: RequirementIdSite, repeat: RequirementIdSite): string {
  const repeatPath = boundedPath(repeat.path);
  const firstPath = boundedPath(first.path);
  const error =
    first.path === repeat.path
      ? configError`duplicate requirement id "${repeat.id}". It is declared at requirements[${first.index}] and again at requirements[${repeat.index}] in ${repeatPath}. Both requirements become the rule intake:${repeat.id}, and a waiver matches on the rule and the surface, so one waiver would cover a requirement its author never saw. Give each requirement its own id.`
      : configError`duplicate requirement id "${repeat.id}". It is declared at requirements[${repeat.index}] in ${repeatPath} and already at requirements[${first.index}] in ${firstPath}. Both requirements become the rule intake:${repeat.id}, and a waiver matches on the rule and the surface, so one waiver would cover a requirement its author never saw. Give each requirement its own id.`;
  return error.message;
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
