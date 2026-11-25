/**
 * How the file system adapter reads a glob before it hands anything to Node's `fs.glob`.
 *
 * Node's `fs.glob` turns each part of a pattern that holds a wildcard into a regular expression,
 * and a part with many wildcards backtracks: `src/` then `*a` twelve times then `*b` took seconds
 * against one file name of 30 letters. A timer in the same process cannot end that work, so a Stop
 * hook could outlast the host's limit and the stop would go on with nothing checked.
 *
 * So the adapter lists wide and then filters. Every part that holds a wildcard becomes `*` (or
 * `.*` when it starts with a dot), which Node tests without a regular expression, and every fixed
 * part stays as written, so the walk Node makes keeps its shape: the same depth, the same fixed
 * folders, and the same rules for dot names and links. Then each listed path is kept only when the
 * written pattern matches it, with a matcher whose time is at most the part's length times the
 * name's length.
 *
 * The filter reads `*`, `**`, `?`, fixed text, and `{a,b}` groups the way Node does (see
 * nodeGlobReading). Node reads other syntax too: character classes such as `[a-z]`, extglob
 * groups such as `+(a|b)` and `!(a)`, brace ranges such as `{1..3}`, and nested or unbalanced
 * braces. A pattern that holds any of those is handed to Node unchanged, but only inside a bound
 * that keeps Node's own matching quick. Past the bound it is not run (see FS_GLOB_BOUND).
 *
 * This unit reads patterns only. It must never decide a verdict.
 */
import type { FsGlob } from '../contracts/index.js';
import { wildcardNameMatcher } from '../primitives/match-glob.js';

/**
 * The bound on a pattern Node runs unchanged. Node backtracks on each `*` run in a part and on
 * each extglob group. On an 8-core machine, `src/` then `*a` four times then `*b` (five runs)
 * took 18.5 seconds against one file name of 250 letters, and Linux allows names of 255 bytes.
 * One extglob group, `src/+(a|aa)b`, took 27 seconds against one name of 40 letters. A character
 * class and `?` each match one character and do not backtrack. So a pattern is run unchanged only
 * when it is at most `length` characters long, holds no extglob group, has at most
 * `starRunsPerPart` runs of `*` in any part, and has braces the filter can expand (at most
 * `expansions` of them). A part that is `**` alone is not a run of `*`: Node walks it without a
 * regular expression. Any pattern that is empty or starts with `/`, itself or in one of its brace
 * expansions, is past the bound too, whatever its syntax: Node would walk it from the root of the
 * machine.
 */
export const FS_GLOB_BOUND = { length: 1024, starRunsPerPart: 1, expansions: 256 } as const;

// Node's own limit: a longer pattern throws before anything is listed.
const NODE_MAX_PATTERN_LENGTH = 64 * 1024;

/** One listing: a pattern handed to Node, and the test each path it lists must pass. */
export interface FsGlobListing {
  // The pattern handed to Node's fs.glob.
  pattern: string;
  // The folder the pattern starts from, relative to the adapter's folder: '' for that folder, or
  // a path such as '..' when the pattern starts there.
  base: string;
  // Whether a path, relative to base and with '/' between its parts, is one the written pattern
  // matches. Null when Node lists exactly what the written pattern names, so no path is tested.
  matches: ((path: string) => boolean) | null;
}

export type FsGlobReading =
  // Listed wide and filtered, one listing for each distinct wide pattern.
  | { kind: 'filtered'; listings: FsGlobListing[] }
  // Syntax the filter does not read, inside the bound: Node runs the written pattern.
  | { kind: 'unchanged' }
  // Syntax the filter does not read, past the bound: nothing is run.
  | { kind: 'past-bound'; reason: string };

export interface FsGlobReadOptions {
  // True on a platform where Node matches without regard to letter case (macOS and Windows).
  nocase: boolean;
}

/** Whether Node's fs.glob matches without regard to letter case on this platform. */
export function nodeGlobIgnoresCase(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

// A character class, or an extglob group such as `+(a)`, `@(a)`, `!(a)`, `*(a)`, or `?(a)`.
const CLASS_CHARACTER = /[[\]]/u;
const EXTGLOB_OPEN = /[?*+@!]\(/u;

// Node expands braces only when the pattern holds a `{...}` with no `{` inside and no line break,
// the test minimatch makes before it expands. Without one, every brace is text.
const NODE_EXPANDS_BRACES = /\{(?:(?!\{).)*\}/u;

/**
 * The brace expansions of a pattern as Node makes them, or null when the braces are of a form this
 * unit does not expand: a nested group, a `}` with no `{`, a `{` with no `}`, or a group with no
 * comma whose body holds `..`, which Node may read as a range such as `{1..3}`. A group right after
 * a `$` is text, as Node keeps `${a,b}`. A group with no comma is text, braces included. An empty
 * expansion is kept, so the caller can see it. Returns 'too-many' past the bound.
 */
function expandBracesAsNode(pattern: string): string[] | null | 'too-many' {
  if (!NODE_EXPANDS_BRACES.test(pattern)) return [pattern];
  let forms = [''];
  let i = 0;
  while (i < pattern.length) {
    const char = pattern.charAt(i);
    if (char === '}') return null;
    if (char !== '{') {
      forms = forms.map((form) => form + char);
      i += 1;
      continue;
    }
    const close = pattern.indexOf('}', i);
    if (close === -1) return null;
    const body = pattern.slice(i + 1, close);
    if (body.includes('{')) return null;
    const group = pattern.slice(i, close + 1);
    const afterDollar = i > 0 && pattern.charAt(i - 1) === '$';
    if (afterDollar || !body.includes(',')) {
      if (!afterDollar && body.includes('..')) return null;
      forms = forms.map((form) => form + group);
    } else {
      const alternatives = body.split(',');
      if (forms.length * alternatives.length > FS_GLOB_BOUND.expansions) return 'too-many';
      forms = forms.flatMap((form) => alternatives.map((alternative) => form + alternative));
    }
    i = close + 1;
  }
  return forms;
}

// A pattern, or one of its brace expansions, that is empty or starts with `/` names no path under
// the folder it is listed from: Node walks it from the root of the machine, as `{,zz}/**` becomes
// `/**`, which can take minutes.
const FROM_ROOT_REASON =
  'it or one of its brace expansions is empty or starts with /, so it names no path in the repository and Node would walk it from the root of the machine';

function fromRoot(written: string, forms: readonly string[] | null | 'too-many'): boolean {
  if (written === '' || written.startsWith('/')) return true;
  return Array.isArray(forms) && forms.some((form) => form === '' || form.startsWith('/'));
}

/**
 * The parts of one expansion after the rewrites Node makes before it walks: repeated slashes are
 * one, a `.` or empty part inside the pattern is dropped, a part followed by `..` is dropped with
 * it (unless it is `.`, `..`, `**`, or empty), and a run of `**` parts is one. A leading `.`, a
 * leading `..`, a leading empty part (an absolute pattern), and a trailing empty part (a pattern
 * that ends with `/`) are kept, as Node keeps them.
 */
function nodeParts(form: string): string[] {
  const parts = form.split(/\/+/u);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i + 1 < parts.length; ) {
      if (parts[i] === '**' && parts[i + 1] === '**') {
        parts.splice(i + 1, 1);
        changed = true;
      } else {
        i += 1;
      }
    }
    for (let i = 1; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (i === 1 && part === '' && parts[0] === '') continue;
      if (part === '.' || part === '') {
        parts.splice(i, 1);
        i -= 1;
        changed = true;
      }
    }
    if (parts[0] === '.' && parts.length === 2 && (parts[1] === '.' || parts[1] === '')) {
      parts.pop();
      changed = true;
    }
    let dots = 0;
    while ((dots = parts.indexOf('..', dots + 1)) !== -1) {
      const before = parts[dots - 1];
      if (before !== undefined && before !== '' && before !== '.' && before !== '..' && before !== '**') {
        const keepDot = dots === 1 && parts[dots + 1] === '**';
        parts.splice(dots - 1, 2, ...(keepDot ? ['.'] : []));
        if (parts.length === 0) parts.push('');
        dots -= 2;
        changed = true;
      }
    }
  }
  return parts;
}

// The leading parts that name the folder a pattern starts from: a run of `.` and `..`. A pattern
// that starts from the root of the machine never gets here (see fromRoot).
function leadingCount(parts: readonly string[]): number {
  let count = 0;
  while (count < parts.length - 1 && (parts[count] === '.' || parts[count] === '..')) count += 1;
  return count;
}

function hasWildcard(part: string): boolean {
  return part.includes('*') || part.includes('?');
}

// A fixed part with a letter that has another case, which a platform that ignores case may hold
// in that other case. `.` and `..` are never widened.
function isFixedWithCase(part: string): boolean {
  return part !== '**' && !hasWildcard(part) && part.toLowerCase() !== part.toUpperCase();
}

// A part as `*`, or `.*` for one that starts with a dot. Node lists every name such a part could
// match: a part that does not start with a dot never matches a name that does.
function widen(part: string): string {
  return part.startsWith('.') ? '.*' : '*';
}

type NamePart = { kind: 'any-parts' } | { kind: 'name'; test: (name: string) => boolean };

function foldings(text: string): [string, string] {
  return [text.toLowerCase(), text.toUpperCase()];
}

// One part as Node's walk tests a name: fixed text must be equal, and a part with `*` or `?` uses
// the matcher that never backtracks. A wildcard part that does not start with a dot never matches
// a name that does (Node's dot rule). Without regard to case, a name matches when it matches in
// lower case or in upper case, which is never narrower than Node's test.
function namePart(part: string, nocase: boolean): NamePart {
  if (part === '**') return { kind: 'any-parts' };
  const dotGuard = !part.startsWith('.');
  if (!hasWildcard(part)) {
    if (!nocase) return { kind: 'name', test: (name) => name === part };
    const [lower, upper] = foldings(part);
    return { kind: 'name', test: (name) => name === part || name.toLowerCase() === lower || name.toUpperCase() === upper };
  }
  if (!nocase) {
    const matches = wildcardNameMatcher(part, { question: true });
    return { kind: 'name', test: (name) => !(dotGuard && name.startsWith('.')) && matches(name) };
  }
  const [lower, upper] = foldings(part).map((text) => wildcardNameMatcher(text, { question: true }));
  return {
    kind: 'name',
    test: (name) =>
      !(dotGuard && name.startsWith('.')) && ((lower?.(name.toLowerCase()) ?? false) || (upper?.(name.toUpperCase()) ?? false)),
  };
}

/**
 * Whether the names of a path match the parts, as Node's walk reads them. `**` stands for zero or
 * more whole names. It passes a name that starts with a dot only when the part after it matches
 * that name, the rule Node's walk uses, so `**` at the end never passes one. Time is at most the
 * number of parts times the number of names, times one name test.
 */
function partsMatch(parts: readonly NamePart[], names: readonly string[]): boolean {
  const count = names.length;
  let reach = new Uint8Array(count + 1);
  reach[0] = 1;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) return false;
    const next = new Uint8Array(count + 1);
    let any = false;
    if (part.kind === 'any-parts') {
      const after = parts[index + 1];
      const passes = (name: string): boolean => !name.startsWith('.') || (after?.kind === 'name' && after.test(name));
      let carry = false;
      for (let at = 0; at <= count; at += 1) {
        carry = reach[at] === 1 || (carry && at > 0 && passes(names[at - 1] ?? ''));
        if (carry) {
          next[at] = 1;
          any = true;
        }
      }
    } else {
      for (let at = 0; at < count; at += 1) {
        if (reach[at] === 1 && part.test(names[at] ?? '')) {
          next[at + 1] = 1;
          any = true;
        }
      }
    }
    if (!any) return false;
    reach = next;
  }
  return reach[count] === 1;
}

interface FormReading {
  base: string[];
  rest: string[];
}

// Why a pattern Node runs unchanged is past the bound, or null when it is inside it.
function boundProblem(pattern: string, forms: readonly string[] | null | 'too-many'): string | null {
  if (pattern.length > FS_GLOB_BOUND.length) {
    return `it is longer than ${String(FS_GLOB_BOUND.length)} characters`;
  }
  if (EXTGLOB_OPEN.test(pattern)) {
    return 'it holds an extglob group such as +(a|b), which can take Node a very long time to match';
  }
  if (forms === 'too-many') {
    return `its brace groups expand to more than ${String(FS_GLOB_BOUND.expansions)} patterns`;
  }
  if (forms === null) {
    return 'it holds a brace range or a nested or unbalanced brace, which can expand to very many patterns';
  }
  for (const form of forms) {
    for (const part of form.split('/')) {
      if (part === '**') continue;
      const runs = part.match(/\*+/gu)?.length ?? 0;
      if (runs > FS_GLOB_BOUND.starRunsPerPart) {
        return `a part holds more than ${String(FS_GLOB_BOUND.starRunsPerPart)} run of * with other syntax Node must match itself`;
      }
    }
  }
  return null;
}

/**
 * How the adapter reads one pattern. Node first reads every `\` as `/`, so this does too.
 *
 * The filter reads a pattern made of fixed text, `*`, `**`, `?`, and brace groups Node expands the
 * same way (see expandBracesAsNode). Each expansion is split into parts the way Node splits it,
 * and one wide listing is made for each distinct wide pattern. On a platform that ignores case, a
 * second listing also widens every fixed part that holds a letter, so a folder named in other
 * letter case is listed, and every test ignores case. A `.` or `..` part Node still walks after
 * its rewrites, such as a `..` after `**`, is not read by the filter, so that listing is kept whole.
 *
 * Any other pattern is run by Node unchanged when it is inside FS_GLOB_BOUND, and not at all past
 * it. A pattern longer than Node's own limit is handed to Node, which refuses it.
 */
export function nodeGlobReading(pattern: string, options: FsGlobReadOptions): FsGlobReading {
  if (pattern.length > NODE_MAX_PATTERN_LENGTH) return { kind: 'unchanged' };
  const written = pattern.replace(/\\/gu, '/');
  const forms = expandBracesAsNode(written);
  if (fromRoot(written, forms)) return { kind: 'past-bound', reason: FROM_ROOT_REASON };
  if (!Array.isArray(forms) || CLASS_CHARACTER.test(written) || EXTGLOB_OPEN.test(written)) {
    const problem = boundProblem(written, forms);
    return problem === null ? { kind: 'unchanged' } : { kind: 'past-bound', reason: problem };
  }
  const readings: FormReading[] = forms.map((form) => {
    const parts = nodeParts(form);
    const lead = leadingCount(parts);
    return { base: parts.slice(0, lead), rest: parts.slice(lead) };
  });

  const listings = new Map<string, { base: string; tests: Array<((path: string) => boolean) | null> }>();
  const add = (base: string[], listed: string[], test: ((path: string) => boolean) | null): void => {
    const key = [...base, ...listed].join('/');
    const entry = listings.get(key) ?? { base: base.join('/'), tests: [] };
    entry.tests.push(test);
    listings.set(key, entry);
  };
  for (const { base, rest } of readings) {
    // A pattern that names only a folder, such as `.` or `..`, lists no file.
    if (rest.length === 0 || (rest.length === 1 && rest[0] === '')) continue;
    // A `.` or `..` left after a wildcard, as in `src/**/../x`, or a `.` at the end, is walked by
    // Node in ways the filter does not read. The wide listing is kept whole: every file it lists
    // is one Node could list, which is never narrower than Node's answer.
    if (rest.some((part) => part === '.' || part === '..')) {
      add(base, rest.map((part) => (part === '**' || !hasWildcard(part) ? part : widen(part))), null);
      if (options.nocase) add(base, rest.map((part) => (isFixedWithCase(part) || hasWildcard(part) ? widen(part) : part)), null);
      continue;
    }
    // A trailing empty part names the folder or link the parts before it match.
    const matched = rest[rest.length - 1] === '' ? rest.slice(0, -1) : rest;
    const compiled = matched.map((part) => namePart(part, options.nocase));
    const test = (path: string): boolean => partsMatch(compiled, path.split('/'));
    const wide = rest.map((part) => (part === '**' || !hasWildcard(part) ? part : widen(part)));
    const unchanged = wide.every((part, index) => part === rest[index]);
    add(base, wide, unchanged && !options.nocase ? null : test);
    if (options.nocase && rest.some(isFixedWithCase)) {
      add(
        base,
        rest.map((part) => (isFixedWithCase(part) || (part !== '**' && hasWildcard(part)) ? widen(part) : part)),
        test,
      );
    }
  }
  return {
    kind: 'filtered',
    listings: [...listings].map(([key, { base, tests }]) => ({
      pattern: key,
      base,
      matches: tests.includes(null) ? null : (path) => tests.some((test) => test?.(path) ?? false),
    })),
  };
}

/**
 * Why the adapter would not run a pattern, or null when it runs it. A caller that must not read a
 * pattern it did not run as one that matched nothing, such as the workspace packages, asks first.
 * A pattern longer than Node's own limit is named too, because Node refuses it.
 */
export function fsGlobBoundProblem(pattern: string): string | null {
  if (pattern.length > NODE_MAX_PATTERN_LENGTH) {
    return `it is longer than ${String(NODE_MAX_PATTERN_LENGTH)} characters, which Node refuses`;
  }
  const reading = nodeGlobReading(pattern, { nocase: false });
  return reading.kind === 'past-bound' ? reading.reason : null;
}

// A character Node's glob reads as syntax in a name, or `\`, which it reads as `/`.
const NODE_GLOB_SYNTAX = /[*?[\]{}()\\]/u;

/**
 * The files the patterns match under one folder, with the folder's name read as plain text, or
 * null when the reader cannot list them that way. A reader with globUnder lists them with the
 * folder as the walk's start. A reader without it, such as a wrapper that passes glob through, is
 * given the folder in the pattern only when its name holds nothing Node reads as syntax, so the
 * answer is the same. Otherwise the caller must read the folder as one it could not list.
 */
export async function globUnderFolder(fs: FsGlob, folder: string, patterns: readonly string[]): Promise<string[] | null> {
  const under = folder.replace(/\/+$/u, '');
  if (fs.globUnder !== undefined) return fs.globUnder(under, [...patterns]);
  if (under === '') return fs.glob([...patterns]);
  if (NODE_GLOB_SYNTAX.test(under)) return null;
  return fs.glob(patterns.map((pattern) => `${under}/${pattern}`));
}
