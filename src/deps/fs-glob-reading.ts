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
 * regular expression. A pattern that names a path outside the folder it is listed from is past
 * the bound too, whatever its syntax: one that is empty or starts with `/`, which Node walks from
 * the root of the machine; one that climbs above the folder with `..`; and, on Windows, one whose
 * first part is a drive such as `C:`, which Node walks from the root of that drive. So is a pattern
 * with a `..` after a wildcard part, which Node walks in a way the adapter cannot match. Each brace
 * expansion is checked too.
 */
export const FS_GLOB_BOUND = { length: 1024, starRunsPerPart: 1, expansions: 256 } as const;

// Node's own limit: a longer pattern throws before anything is listed.
const NODE_MAX_PATTERN_LENGTH = 64 * 1024;

/** One listing: the patterns handed to Node in one call, and the test each path must pass. */
export interface FsGlobListing {
  // The patterns handed to Node's fs.glob in one call.
  patterns: string[];
  // The folder the patterns start from, relative to the adapter's folder: '' for that folder, or
  // '.' for a pattern that starts with './'.
  base: string;
  // Whether a path, relative to base and with '/' between its parts, is one the written pattern
  // matches. Null when Node lists exactly what the written pattern names, so no path is tested.
  matches: ((path: string) => boolean) | null;
}

export type FsGlobReading =
  // Listed wide and filtered: one listing for each group of sets that can share one call.
  | { kind: 'filtered'; listings: FsGlobListing[] }
  // Syntax the filter does not read, inside the bound: Node runs the written pattern.
  | { kind: 'unchanged' }
  // Syntax the filter does not read, past the bound: nothing is run.
  | { kind: 'past-bound'; reason: string };

export interface FsGlobReadOptions {
  // True on a platform where Node matches without regard to letter case (macOS and Windows).
  nocase: boolean;
  // True on Windows, where Node walks a first name that ends with `:` from the root of a drive.
  // Elsewhere such a name is a plain folder name.
  windows?: boolean;
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

// Why a pattern names a path outside the folder it is listed from, or a `..` the adapter cannot
// list the way Node does, or null for neither. Each reason is past the bound, whatever the syntax.
const OUTSIDE_REASONS = {
  root: 'it or one of its brace expansions is empty or starts with /, so it names no path in the repository and Node would walk it from the root of the machine',
  climb: 'it or one of its brace expansions climbs above the folder it is listed from with .., so it names a path outside the repository',
  drive: 'it or one of its brace expansions starts with a drive name such as C:, which Node on Windows walks from the root of that drive',
  dots: 'it or one of its brace expansions has a .. after a wildcard part, which Node walks in a way that depends on the other expansions, so usabl could list fewer files than Node',
} as const;

// Any character Node may read as syntax in a part. A part without one is fixed text to Node.
const PART_SYNTAX = /[*?[\]()]/u;

/**
 * Node's first rewrite of the parts of each expansion, as minimatch makes it at optimization
 * level 2 (firstPhasePreProcess): a run of `**` is one, a `**` followed by `..` and two more
 * names is split into two sets, a `.` or empty part inside the pattern is dropped, and a part
 * followed by `..` is dropped with it (unless it is `.`, `..`, `**`, or empty). Repeated slashes
 * are one. The sets are changed in place and new ones are added at the end, as Node does.
 */
function firstPhaseSets(forms: readonly string[]): string[][] {
  const sets = forms.map((form) => form.split(/\/+/u));
  let changed = true;
  while (changed) {
    changed = false;
    for (const parts of sets) {
      let gs = -1;
      while ((gs = parts.indexOf('**', gs + 1)) !== -1) {
        let end = gs;
        while (parts[end + 1] === '**') end += 1;
        if (end > gs) parts.splice(gs + 1, end - gs);
        const next = parts[gs + 1];
        const p = parts[gs + 2];
        const p2 = parts[gs + 3];
        if (next !== '..') continue;
        if (p === undefined || p === '' || p === '.' || p === '..' || p2 === undefined || p2 === '' || p2 === '.' || p2 === '..') {
          continue;
        }
        changed = true;
        parts.splice(gs, 1);
        const other = parts.slice(0);
        other[gs] = '**';
        sets.push(other);
        gs -= 1;
      }
      for (let i = 1; i < parts.length - 1; i += 1) {
        const part = parts[i];
        if (i === 1 && part === '' && parts[0] === '') continue;
        if (part === '.' || part === '') {
          changed = true;
          parts.splice(i, 1);
          i -= 1;
        }
      }
      if (parts[0] === '.' && parts.length === 2 && (parts[1] === '.' || parts[1] === '')) {
        changed = true;
        parts.pop();
      }
      let dots = 0;
      while ((dots = parts.indexOf('..', dots + 1)) !== -1) {
        const before = parts[dots - 1];
        if (before !== undefined && before !== '' && before !== '.' && before !== '..' && before !== '**') {
          changed = true;
          const keepDot = dots === 1 && parts[dots + 1] === '**';
          parts.splice(dots - 1, 2, ...(keepDot ? ['.'] : []));
          if (parts.length === 0) parts.push('');
          dots -= 2;
        }
      }
    }
  }
  return sets;
}

/**
 * Two sets as one wider set, or null, as minimatch merges them (partsMatch with empty `**`
 * matches on). Node then walks only the merged set: `x/a/** /y` and `x/** /a/y` (written here
 * with spaces) become `x/** /a/** /y`, which also matches `x/p/a/q/y`.
 */
function mergedSet(a: readonly string[], b: readonly string[]): string[] | null {
  let ai = 0;
  let bi = 0;
  const result: string[] = [];
  let which = '';
  while (ai < a.length && bi < b.length) {
    const left = a[ai] ?? '';
    const right = b[bi] ?? '';
    if (left === right) {
      result.push(left);
      ai += 1;
      bi += 1;
    } else if (left === '**' && right === a[ai + 1]) {
      result.push(left);
      ai += 1;
    } else if (right === '**' && left === b[bi + 1]) {
      result.push(right);
      bi += 1;
    } else if (left === '*' && right !== '' && !right.startsWith('.') && right !== '**') {
      if (which === 'b') return null;
      which = 'a';
      result.push(left);
      ai += 1;
      bi += 1;
    } else if (right === '*' && left !== '' && !left.startsWith('.') && left !== '**') {
      if (which === 'a') return null;
      which = 'b';
      result.push(right);
      ai += 1;
      bi += 1;
    } else {
      return null;
    }
  }
  return a.length === b.length ? result : null;
}

// Node's second rewrite (secondPhasePreProcess): each set is merged into the first later set it
// merges with, and the sets Node walks are what is left.
function secondPhaseSets(sets: string[][]): string[][] {
  for (let i = 0; i < sets.length - 1; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const merged = mergedSet(sets[i] ?? [], sets[j] ?? []);
      if (merged !== null) {
        sets[i] = [];
        sets[j] = merged;
        break;
      }
    }
  }
  return sets.filter((set) => set.length > 0);
}

// Why one set names a path outside the folder, or null. The depth counts the fewest names a path
// can have at each part: `**` may be none, `.` stays, and `..` goes up one. Below zero, the path
// is above the folder. On Windows a first fixed part that ends with `:` is a drive, and Node walks
// it from the root of that drive.
function outsideReason(set: readonly string[], windows: boolean): keyof typeof OUTSIDE_REASONS | null {
  if (set.length === 0 || set[0] === '') return 'root';
  let depth = 0;
  for (const part of set) {
    if (part === '..') depth -= 1;
    else if (part !== '.' && part !== '**' && part !== '') depth += 1;
    if (depth < 0) return 'climb';
  }
  const first = set.find((part) => part !== '.');
  if (windows && first !== undefined && first.endsWith(':') && !PART_SYNTAX.test(first)) return 'drive';
  return null;
}

// Whether a `..` part comes after a part with glob syntax, read as written, before Node's
// rewrites. Node's walk of `**/..` writes to state it shares with the pattern's other expansions,
// so which files it finds depends on what it walks together: a run found `x` for
// `{*a*,**/a,*}/{b,*a*/**,**/..}/*` that no listing of single sets found. The guard reads such an
// entry the same way.
function dotsAfterWildcard(form: string): boolean {
  let afterWildcard = false;
  for (const part of form.split('/')) {
    if (part === '..' && afterWildcard) return true;
    if (part === '**' || PART_SYNTAX.test(part)) afterWildcard = true;
  }
  return false;
}

function outsideProblem(written: string, forms: readonly string[] | null | 'too-many', windows: boolean): string | null {
  const expanded = Array.isArray(forms) ? forms : [written];
  if (written === '' || written.startsWith('/') || expanded.some((form) => form === '' || form.startsWith('/'))) {
    return OUTSIDE_REASONS.root;
  }
  for (const set of firstPhaseSets(expanded)) {
    const reason = outsideReason(set, windows);
    if (reason !== null) return OUTSIDE_REASONS[reason];
  }
  if (expanded.some(dotsAfterWildcard)) return OUTSIDE_REASONS.dots;
  return null;
}

// The leading parts that name the folder a set starts from: a run of `.`. A set that starts above
// the folder or at the root never gets here (see outsideProblem).
function leadingCount(parts: readonly string[]): number {
  let count = 0;
  while (count < parts.length - 1 && parts[count] === '.') count += 1;
  return count;
}

function hasWildcard(part: string): boolean {
  return part.includes('*') || part.includes('?');
}

function starRuns(part: string): number {
  return part.match(/\*+/gu)?.length ?? 0;
}

// A part Node could backtrack on: more than one run of `*`. A part with one run, such as `src*`
// or `a?b*`, is kept as written, so Node keeps the pruning its fixed text gives.
function needsWidening(part: string): boolean {
  return part !== '**' && starRuns(part) > FS_GLOB_BOUND.starRunsPerPart;
}

// A part as `*`, or `.*` for one that starts with a dot. Node lists every name such a part could
// match: a part that does not start with a dot never matches a name that does.
function widen(part: string): string {
  return part.startsWith('.') ? '.*' : '*';
}

type NamePart = { kind: 'any-parts' } | { kind: 'name'; test: (name: string) => boolean };

/**
 * Text as a regular expression with the `i` flag and no `u` flag compares it, one UTF-16 code
 * unit at a time: a unit becomes its upper case when that is one unit, except that a unit past
 * ASCII never becomes an ASCII one. So `ß` stays `ß`, and `σ` and `ς` both become `Σ`.
 */
function regexFold(text: string): string {
  let folded = '';
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charAt(i);
    const upper = unit.toUpperCase();
    folded += upper.length === 1 && !(unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? upper : unit;
  }
  return folded;
}

const FOLDINGS: ReadonlyArray<(text: string) => string> = [regexFold, (text) => text.toLowerCase(), (text) => text.toUpperCase()];

// One part as Node's walk tests a name: fixed text must be equal, and a part with `*` or `?` uses
// the matcher that never backtracks. A wildcard part that does not start with a dot never matches
// a name that does (Node's dot rule). Without regard to case, a name matches when it matches after
// any of three foldings: the one Node's regular expression uses, lower case, or upper case. That
// is never narrower than Node's test.
function namePart(part: string, nocase: boolean, listedAsWritten: boolean): NamePart {
  if (part === '**') return { kind: 'any-parts' };
  const dotGuard = !part.startsWith('.');
  // Without regard to case, Node already tested a wildcard part it was given as written, with
  // rules none of the foldings fully match: its fast test for `?` then text, such as `??ß`,
  // compares the end of the name in lower case, so `aİẞ` passes. Its answer is kept, with only
  // its dot rule.
  if (nocase && listedAsWritten && hasWildcard(part)) return { kind: 'name', test: (name) => !(dotGuard && name.startsWith('.')) };
  if (!hasWildcard(part)) {
    if (!nocase) return { kind: 'name', test: (name) => name === part };
    const folded = FOLDINGS.map((fold) => fold(part));
    return { kind: 'name', test: (name) => name === part || FOLDINGS.some((fold, index) => fold(name) === folded[index]) };
  }
  if (!nocase) {
    const matches = wildcardNameMatcher(part, { question: true });
    return { kind: 'name', test: (name) => !(dotGuard && name.startsWith('.')) && matches(name) };
  }
  const matchers = FOLDINGS.map((fold) => wildcardNameMatcher(fold(part), { question: true }));
  return {
    kind: 'name',
    test: (name) => !(dotGuard && name.startsWith('.')) && FOLDINGS.some((fold, index) => matchers[index]?.(fold(name)) ?? false),
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
      if (part !== '**' && starRuns(part) > FS_GLOB_BOUND.starRunsPerPart) {
        return `a part holds more than ${String(FS_GLOB_BOUND.starRunsPerPart)} run of * with other syntax Node must match itself`;
      }
    }
  }
  return null;
}

// One set Node walks, as the adapter lists it.
interface SetListing {
  base: string;
  // The set's parts after the base, as listed.
  listed: string[];
  // The test for a path the listing finds, or null when every path it finds is kept.
  test: ((path: string) => boolean) | null;
}

// Whether two listed beginnings can reach the same folder. Node names a folder by the text of the
// parts that led to it, and a fixed part adds its own text. So two beginnings never meet when, read
// from the start or from the end up to a `**`, one part is fixed text in both and the texts
// differ, or when neither holds `**` and their lengths differ.
function canMeet(a: readonly string[], b: readonly string[]): boolean {
  const differ = (left: string | undefined, right: string | undefined): boolean =>
    left !== undefined && right !== undefined && !PART_SYNTAX.test(left) && !PART_SYNTAX.test(right) && left !== right;
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] !== '**' && b[i] !== '**'; i += 1) {
    if (differ(a[i], b[i])) return false;
  }
  for (let i = 1; i <= Math.min(a.length, b.length) && a[a.length - i] !== '**' && b[b.length - i] !== '**'; i += 1) {
    if (differ(a[a.length - i], b[b.length - i])) return false;
  }
  return a.includes('**') || b.includes('**') || a.length === b.length;
}

/**
 * Node keeps one cache for all the patterns of one call, keyed by a folder and the rest of a
 * pattern from some part on. When a second pattern reaches a folder with a rest already seen
 * there, Node skips it, and a run found that this can lose a file one of the patterns lists on its
 * own. So two listed patterns share one call only when they are the same text, or when no rest
 * of one is a rest of the other at a folder both can reach. Sets that share a call share a test:
 * a path is kept when any of their sets matches it.
 */
function shareCalls(sets: readonly SetListing[]): SetListing[][] {
  interface Rest {
    whole: string;
    before: string[];
  }
  const groups: Array<{ members: SetListing[]; rests: Map<string, Rest[]> }> = [];
  for (const set of sets) {
    const whole = set.listed.join('/');
    const rests: Array<[string, Rest]> = [];
    for (let at = 0; at < set.listed.length; at += 1) {
      rests.push([set.listed.slice(at).join('/'), { whole, before: set.listed.slice(0, at) }]);
    }
    const clashes = (seen: Map<string, Rest[]>): boolean =>
      rests.some(([listed, rest]) => (seen.get(listed) ?? []).some((other) => other.whole !== rest.whole && canMeet(other.before, rest.before)));
    const group = groups.find(
      (candidate) =>
        candidate.members[0]?.base === set.base && (candidate.members[0].test === null) === (set.test === null) && !clashes(candidate.rests),
    );
    const target = group ?? { members: [], rests: new Map<string, Rest[]>() };
    if (group === undefined) groups.push(target);
    target.members.push(set);
    for (const [listed, rest] of rests) target.rests.set(listed, [...(target.rests.get(listed) ?? []), rest]);
  }
  return groups.map((group) => group.members);
}

/**
 * How the adapter reads one pattern. Node first reads every `\` as `/`, so this does too.
 *
 * A pattern that names a path outside the folder (from the root, above it with `..`, or at a
 * drive on Windows), or that has a `..` after a wildcard part, is past the bound and not run. Otherwise the filter reads a pattern made of fixed text,
 * `*`, `**`, `?`, and brace groups Node expands the same way (see expandBracesAsNode). The adapter
 * makes the sets Node walks, with Node's two rewrites. When no part of any set has more than one
 * run of `*`, Node cannot backtrack, and it runs the written pattern itself. Otherwise each such
 * part is listed as `*`, every other part stays as written, so Node's walk keeps its shape, and a
 * listed path is kept when the set matches it. Without regard to case (macOS and Windows), the
 * test ignores case too, fixed parts stay as written (a volume that ignores case finds `SRC`
 * through `src`), and a wildcard part listed as written keeps the answer Node gave it. A set that
 * ends with a `.` part is not read by the filter, so that listing is kept whole.
 *
 * Any other pattern is run by Node unchanged when it is inside FS_GLOB_BOUND, and not at all past
 * it. A pattern longer than Node's own limit is handed to Node, which refuses it.
 */
export function nodeGlobReading(pattern: string, options: FsGlobReadOptions): FsGlobReading {
  if (pattern.length > NODE_MAX_PATTERN_LENGTH) return { kind: 'unchanged' };
  const written = pattern.replace(/\\/gu, '/');
  const forms = expandBracesAsNode(written);
  const outside = outsideProblem(written, forms, options.windows ?? false);
  if (outside !== null) return { kind: 'past-bound', reason: outside };
  if (!Array.isArray(forms) || CLASS_CHARACTER.test(written) || EXTGLOB_OPEN.test(written)) {
    const problem = boundProblem(written, forms);
    return problem === null ? { kind: 'unchanged' } : { kind: 'past-bound', reason: problem };
  }
  const sets = secondPhaseSets(firstPhaseSets(forms));
  if (!sets.some((set) => set.some(needsWidening))) return { kind: 'unchanged' };

  const listings: SetListing[] = [];
  for (const set of sets) {
    const lead = leadingCount(set);
    const rest = set.slice(lead);
    // A set that names only a folder, such as `.`, lists no file.
    if (rest.length === 0 || (rest.length === 1 && rest[0] === '')) continue;
    const listed = rest.map((part) => (needsWidening(part) ? widen(part) : part));
    const base = set.slice(0, lead).join('/');
    // A `.` at the end is walked by Node in a way the filter does not read. The wide listing is
    // kept whole. A `..` never gets here: one after a wildcard is past the bound, and Node folds
    // away every other one inside the folder.
    if (rest.some((part) => part === '.' || part === '..')) {
      listings.push({ base, listed, test: null });
      continue;
    }
    // A trailing empty part names the folder or link the parts before it match.
    const matched = rest[rest.length - 1] === '' ? rest.slice(0, -1) : rest;
    const compiled = matched.map((part) => namePart(part, options.nocase, !needsWidening(part)));
    const test = (path: string): boolean => partsMatch(compiled, path.split('/'));
    const unchanged = listed.every((part, index) => part === rest[index]);
    listings.push({ base, listed, test: unchanged ? null : test });
  }
  return {
    kind: 'filtered',
    listings: shareCalls(listings).map((members) => {
      const tests = members.map((member) => member.test);
      const base = members[0]?.base ?? '';
      return {
        patterns: [...new Set(members.map((member) => (base === '' ? '' : `${base}/`) + member.listed.join('/')))],
        base,
        matches: tests.includes(null) ? null : (path: string) => tests.some((test) => test?.(path) ?? false),
      };
    }),
  };
}

/**
 * Why the adapter would not run a pattern, or null when it runs it. A caller that must not read a
 * pattern it did not run as one that matched nothing, such as the workspace packages, asks first.
 * A pattern longer than Node's own limit is named too, because Node refuses it.
 */
export function fsGlobBoundProblem(pattern: string, platform: NodeJS.Platform = process.platform): string | null {
  if (pattern.length > NODE_MAX_PATTERN_LENGTH) {
    return `it is longer than ${String(NODE_MAX_PATTERN_LENGTH)} characters, which Node refuses`;
  }
  const reading = nodeGlobReading(pattern, { nocase: false, windows: platform === 'win32' });
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
