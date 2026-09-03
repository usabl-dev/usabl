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
 */

// Expand one level of {a,b} groups into every literal combination. Returns null when the
// braces are nested or malformed, which signals the caller to leave the pattern alone.
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
  // Encode **/? first so src/**/*.tsx matches src/App.tsx and deeper files.
  return new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\x00/g, '.*') +
      '$',
  );
}

export function matchGlob(pattern: string, file: string): boolean {
  const expansions = pattern.includes('{') ? expandBraces(pattern) : [pattern];
  // A pattern this unit cannot expand falls back to literal-brace matching, which is the
  // prior behavior. The config-load guard refuses such patterns before a run reaches here.
  const patterns = expansions ?? [pattern];
  return patterns.some((expanded) => compileToRegExp(expanded).test(file));
}
