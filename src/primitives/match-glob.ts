/**
 * Shared glob matcher for planner and in-memory fakes.
 * One glob dialect keeps coverage planning and tests aligned on which files are UI.
 * This unit must never read files or infer coverage by itself.
 *
 * Supported syntax: `*`, `**`, literal text, and single-level `{a,b,c}` brace groups.
 * A pattern with brace groups matches a file when any expansion of the groups matches
 * under the star rules. Multiple groups expand as a cartesian product. Nested braces are
 * not expanded here; the config-load guard refuses patterns with syntax this unit cannot
 * evaluate, so a caller never reaches matchGlob with an unsupported pattern.
 *
 * A brace expands only when its body contains a comma. Node's glob and minimatch treat a
 * comma-less `{...}` as literal text, so `{tsx}` matches a filename that literally contains
 * `{tsx}`, not one where the braces are stripped. matchGlob follows the same rule so it
 * classifies files the same way discovery does.
 */

/**
 * Characters this unit cannot evaluate the way Node's glob does: a character class, an extglob
 * group, a single-character wildcard, and an escape. Node reads `\x` as `x`, while this unit reads
 * the backslash as text. Config load refuses a glob that holds one, and the guard refuses such an
 * entry read at a trusted ref.
 */
export const UNSUPPORTED_GLOB_CHARACTERS: readonly string[] = ['[', ']', '(', ')', '?', '\\'];

/**
 * The first brace range in a pattern, such as `{1..3}` or `{a..c}`, or null when there is none.
 * Node's glob expands a comma-less brace whose body is a range, while expandBraces keeps every
 * comma-less brace as text. So a range would select files at discovery that this unit never
 * matches. A comma-less body with `..` in it counts as a range, so no range form slips through.
 */
export function braceRangeIn(pattern: string): string | null {
  for (const match of pattern.matchAll(/\{([^{}]*)\}/g)) {
    const body = match[1] ?? '';
    if (!body.includes(',') && body.includes('..')) {
      return match[0];
    }
  }
  return null;
}

// Expand one level of {a,b} groups into every literal combination. A comma-less {...} is
// literal, so its braces stay in the output. Returns null when a brace is nested or
// unbalanced, which signals the caller to leave the pattern alone.
export function expandBraces(pattern: string): string[] | null {
  let results = [''];
  let i = 0;
  while (i < pattern.length) {
    const char = pattern.charAt(i);
    if (char === '}') {
      // A closing brace with no matching open is malformed.
      return null;
    }
    if (char === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        return null;
      }
      const body = pattern.slice(i + 1, close);
      // A nested open brace inside the group is not handled here.
      if (body.includes('{')) {
        return null;
      }
      // A comma-less brace is not a group. Keep the braces as literal text, matching Node.
      if (!body.includes(',')) {
        results = results.map((prefix) => prefix + '{' + body + '}');
        i = close + 1;
        continue;
      }
      const alternatives = body.split(',');
      const next: string[] = [];
      for (const prefix of results) {
        for (const alternative of alternatives) {
          next.push(prefix + alternative);
        }
      }
      results = next;
      i = close + 1;
      continue;
    }
    results = results.map((prefix) => prefix + char);
    i++;
  }
  return results;
}

function compileToRegExp(pattern: string): RegExp {
  // Encode **/? first so src/**/*.tsx matches src/App.tsx and deeper files. `**` becomes
  // [\s\S]*, which matches any character, a newline too: git allows a newline in a file name,
  // and `.` would skip it, so such a changed file would read as outside the globs.
  return new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\x00/g, '[\\s\\S]*') +
      '$',
  );
}

export interface GlobOptions {
  // False: a wildcard never matches a name that starts with a dot, the rule Node's fs.glob uses.
  // A dot written in the pattern itself still matches. The default, true, is the planner's rule.
  dot?: boolean;
}

// A path segment a wildcard may match when dot names are excluded: any name that does not start
// with a dot.
const NON_DOT_NAME = '(?!\\.)[^/]+';

function segmentWithoutDotMatch(segment: string): string {
  const body = segment.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*+/g, '[^/]*');
  return segment.startsWith('.') ? body : `(?!\\.)${body}`;
}

// The same dialect with Node's dot rule, built one segment at a time so `**` can skip only
// segments that do not start with a dot. A `**` segment matches zero or more whole segments, and
// a trailing `**` matches every file beneath.
function compileWithoutDotMatch(pattern: string): RegExp {
  const segments = pattern.split('/');
  let source = '';
  let slash = false;
  segments.forEach((segment, index) => {
    const separator = slash ? '/' : '';
    if (segment === '**') {
      if (index === segments.length - 1) {
        source += `${separator}${NON_DOT_NAME}(?:/${NON_DOT_NAME})*`;
        slash = true;
      } else {
        source += `${separator}(?:${NON_DOT_NAME}/)*`;
        slash = false;
      }
      return;
    }
    source += separator + segmentWithoutDotMatch(segment);
    slash = true;
  });
  return new RegExp(`^${source}$`);
}

/**
 * A compiled matcher for one pattern, for callers that test many files against it. It gives the
 * same answers as matchGlob.
 */
export function globMatcher(pattern: string, options: GlobOptions = {}): (file: string) => boolean {
  const expansions = pattern.includes('{') ? expandBraces(pattern) : [pattern];
  // A pattern this unit cannot expand falls back to literal-brace matching, which is the
  // prior behavior. The config-load guard refuses such patterns before a run reaches here.
  const patterns = expansions ?? [pattern];
  const compile = options.dot === false ? compileWithoutDotMatch : compileToRegExp;
  const compiled = patterns.map(compile);
  return (file: string): boolean => compiled.some((rx) => rx.test(file));
}

export function matchGlob(pattern: string, file: string, options: GlobOptions = {}): boolean {
  return globMatcher(pattern, options)(file);
}
