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
 * The cost of matching also grows with the length of each pattern and with every entry together,
 * and one very long pattern makes the regular expression engine throw. So a list has three more
 * bounds, each far above what a real config holds:
 * - 1024 characters for each pattern an entry expands to. A real glob is a short path pattern, and
 *   a pattern this long stays far below the size the engine refuses (it refused one of about
 *   100,000 characters).
 * - 4096 patterns across the whole list: sixteen entries at the cap of 256 each.
 * - 262,144 characters across every pattern of the list, the count of each entry times its length:
 *   256 patterns of 1024 characters, or 4096 of 64. At 4096 patterns of 1024 characters each
 *   changed file took about 20 ms to match, so the bound keeps a large change quick.
 *
 * Then each entry is built once, so a pattern the engine cannot build is a plain refusal when the
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

/** Throws a config error naming the list and the entry when a list is past one of the bounds. */
export function checkGlobListBounds(globs: readonly string[], label: string): void {
  let patterns = 0;
  let characters = 0;
  for (const glob of globs) {
    const count = countBraceExpansions(glob) ?? 1;
    if (count > MAX_BRACE_EXPANSIONS) {
      throw configError`${label} entry "${glob}" has brace groups that expand to more than ${String(MAX_BRACE_EXPANSIONS)} patterns, more than usabl matches one by one. Split it into several entries, or use a wildcard for the part that varies.`;
    }
    const length = longestExpansionLength(glob);
    if (length > MAX_GLOB_LENGTH) {
      throw configError`${label} entry "${glob}" makes a pattern longer than ${String(MAX_GLOB_LENGTH)} characters, longer than usabl matches. Shorten it, or use a wildcard for the part that varies.`;
    }
    patterns += count;
    characters += count * length;
  }
  if (patterns > MAX_GLOB_PATTERNS) {
    throw configError`${label} entries expand to ${String(patterns)} patterns in all, more than ${String(MAX_GLOB_PATTERNS)}, more than usabl matches one by one. Use fewer entries or fewer brace alternatives, or use a wildcard for the part that varies.`;
  }
  if (characters > MAX_GLOB_PATTERN_CHARACTERS) {
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
