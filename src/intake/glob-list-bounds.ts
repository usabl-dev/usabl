/**
 * The size bounds of a glob list read from policy: uiFileGlobs, discovery.wideBlastGlobs, and
 * guardedPaths in usabl.config.json, and sharedGlobs in usabl.docs.json. Each list is expanded and
 * matched against changed files, so each has the same bounds.
 *
 * The matcher builds one pattern for each brace expansion of an entry, and the count grows as a
 * product of the groups, so a short entry can take a long time or exhaust memory on every file it
 * tests. Past the guard's cap of 256 the entry is refused, never cut to fewer patterns. The count is
 * taken before anything is expanded.
 *
 * The cost of matching also grows with the length of each pattern and with every entry together.
 * The matcher's time for one pattern is at most the pattern's length times the path's length, with
 * no backtracking, so a list has three more bounds, each far above what a real config holds:
 * - 1024 characters for each pattern an entry expands to. A real glob is a short path pattern.
 * - 4096 patterns across the whole list: sixteen entries at the cap of 256 each.
 * - 262,144 characters across every pattern of the list, the count of each entry times its length:
 *   256 patterns of 1024 characters, or 4096 of 64. The bound keeps a large change quick.
 *
 * Then each entry is built once, so a pattern the matcher cannot build is a plain refusal when the
 * file is read, never a crash in the middle of a run. This unit reads patterns only. It must never
 * decide a verdict.
 */
import { configError } from './config-error.js';
import { countBraceExpansions, globMatcher } from '../primitives/match-glob.js';
import { MAX_BRACE_EXPANSIONS } from '../trust/guard.js';

export const MAX_GLOB_LENGTH = 1024;
export const MAX_GLOB_PATTERNS = 4096;
export const MAX_GLOB_PATTERN_CHARACTERS = 262_144;

// The length of the longest pattern an entry's brace groups expand to, counted without expanding
// them: the text outside the groups plus the longest alternative of each group. A comma-less brace
// is text, braces included. An entry whose braces cannot be expanded is matched as text, so its
// length is its own.
function longestExpansionLength(glob: string): number {
  if (countBraceExpansions(glob) === null) {
    return glob.length;
  }
  let length = 0;
  let i = 0;
  while (i < glob.length) {
    const close = glob.charAt(i) === '{' ? glob.indexOf('}', i) : -1;
    const body = close === -1 ? '' : glob.slice(i + 1, close);
    if (close !== -1 && body.includes(',')) {
      length += Math.max(...body.split(',').map((alternative) => alternative.length));
      i = close + 1;
      continue;
    }
    length += 1;
    i += 1;
  }
  return length;
}

/** The first bound a glob list is past, or null when it is inside every bound. */
export type GlobListBoundProblem =
  | { bound: 'expansions'; glob: string }
  | { bound: 'length'; glob: string }
  | { bound: 'patterns'; count: number }
  | { bound: 'characters' };

/**
 * Which bound a glob list is past, counted without expanding any entry. The import graph applies
 * the same bounds to the import.meta.glob patterns it reads from source code.
 */
export function globListBoundProblem(globs: readonly string[]): GlobListBoundProblem | null {
  let patterns = 0;
  let characters = 0;
  for (const glob of globs) {
    const count = countBraceExpansions(glob) ?? 1;
    if (count > MAX_BRACE_EXPANSIONS) {
      return { bound: 'expansions', glob };
    }
    const length = longestExpansionLength(glob);
    if (length > MAX_GLOB_LENGTH) {
      return { bound: 'length', glob };
    }
    patterns += count;
    characters += count * length;
  }
  if (patterns > MAX_GLOB_PATTERNS) {
    return { bound: 'patterns', count: patterns };
  }
  if (characters > MAX_GLOB_PATTERN_CHARACTERS) {
    return { bound: 'characters' };
  }
  return null;
}

/** Throws a config error naming the list and the entry when a list is past one of the bounds. */
export function checkGlobListBounds(globs: readonly string[], label: string): void {
  const problem = globListBoundProblem(globs);
  if (problem?.bound === 'expansions') {
    throw configError`${label} entry "${problem.glob}" has brace groups that expand to more than ${String(MAX_BRACE_EXPANSIONS)} patterns, more than usabl matches one by one. Split it into several entries, or use a wildcard for the part that varies.`;
  }
  if (problem?.bound === 'length') {
    throw configError`${label} entry "${problem.glob}" makes a pattern longer than ${String(MAX_GLOB_LENGTH)} characters, longer than usabl matches. Shorten it, or use a wildcard for the part that varies.`;
  }
  if (problem?.bound === 'patterns') {
    throw configError`${label} entries expand to ${String(problem.count)} patterns in all, more than ${String(MAX_GLOB_PATTERNS)}, more than usabl matches one by one. Use fewer entries or fewer brace alternatives, or use a wildcard for the part that varies.`;
  }
  if (problem?.bound === 'characters') {
    throw configError`${label} entries expand to patterns of more than ${String(MAX_GLOB_PATTERN_CHARACTERS)} characters in all, more than usabl matches quickly. Use fewer or shorter entries, or use a wildcard for the part that varies.`;
  }
  // Both forms of the matcher are built: the planner's, and the one with Node's dot rule that the
  // guard uses. Inside the bounds above neither fails.
  for (const glob of globs) {
    try {
      globMatcher(glob)('');
      globMatcher(glob, { dot: false })('');
    } catch {
      throw configError`${label} entry "${glob}" makes a pattern usabl cannot build. Shorten it, or use a wildcard for the part that varies.`;
    }
  }
}
