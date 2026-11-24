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

/**
 * How many patterns expandBraces would return, without building them, or null when it would
 * return null. The count grows as a product of the groups, so a short pattern can name more
 * patterns than memory holds. A caller checks the count before it expands.
 */
export function countBraceExpansions(pattern: string): number | null {
  let count = 1;
  let i = 0;
  while (i < pattern.length) {
    const char = pattern.charAt(i);
    if (char === '}') {
      return null;
    }
    if (char === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        return null;
      }
      const body = pattern.slice(i + 1, close);
      if (body.includes('{')) {
        return null;
      }
      if (body.includes(',')) {
        count *= body.split(',').length;
      }
      i = close + 1;
      continue;
    }
    i++;
  }
  return count;
}

/*
 * Matching never backtracks. A regular expression with many wildcards tries each way they can
 * split a name, so its time can grow very fast with the name's length, and a timer in the same
 * process cannot end a match that is running. Here the time to match is at most about the
 * pattern's length times the path's length. Both dot rules give the answers the regular
 * expressions this unit used before gave, character for character.
 */

/**
 * A matcher for one part of a path between slashes: `*` matches any run of characters, and, when
 * `question` is set, `?` matches any one character. Every other character stands for itself. Time
 * is at most the part's length times the name's length: the pieces between the stars are placed
 * from the left, each at its first place, which is the classic glob algorithm and never backtracks.
 */
export function wildcardNameMatcher(part: string, options: { question?: boolean } = {}): (name: string) => boolean {
  const question = options.question === true;
  const pieces = part.split(/\*+/);
  const first = pieces[0] ?? '';
  const last = pieces[pieces.length - 1] ?? '';
  const middle = pieces.slice(1, -1).filter((piece) => piece.length > 0);
  const fixedLength = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const pieceAt = (piece: string, name: string, at: number): boolean => {
    if (!question) return name.startsWith(piece, at);
    for (let i = 0; i < piece.length; i += 1) {
      const char = piece.charCodeAt(i);
      if (char !== QUESTION && char !== name.charCodeAt(at + i)) return false;
    }
    return true;
  };
  const findPiece = (piece: string, name: string, from: number): number => {
    if (!question || !piece.includes('?')) return name.indexOf(piece, from);
    for (let at = from; at + piece.length <= name.length; at += 1) {
      if (pieceAt(piece, name, at)) return at;
    }
    return -1;
  };
  if (pieces.length === 1) {
    return (name) => name.length === first.length && pieceAt(first, name, 0);
  }
  return (name) => {
    if (name.length < fixedLength) return false;
    if (!pieceAt(first, name, 0) || !pieceAt(last, name, name.length - last.length)) return false;
    let position = first.length;
    const end = name.length - last.length;
    for (const piece of middle) {
      const found = findPiece(piece, name, position);
      if (found === -1 || found + piece.length > end) return false;
      position = found + piece.length;
    }
    return true;
  };
}

const QUESTION = 0x3f;
const SLASH = 0x2f;

// The planner's dialect as a list of steps. A literal character matches itself, a star matches any
// run of characters but a slash, and a double star matches any run of characters, slashes and
// newlines included: git allows a newline in a file name, and a changed file with one must not
// read as outside the globs. `**/` is one double star, so src/**/*.tsx matches src/App.tsx and
// deeper files. A NUL character is a double star too, as it was in the regular expression.
const LITERAL = 0;
const STAR = 1;
const DOUBLE_STAR = 2;

interface AnyDepthProgram {
  kinds: Uint8Array;
  chars: Uint16Array;
  // 1 when a literal may be left out: the regular expression read a `?` after a character as
  // "this character or nothing". Config load refuses `?`, so no policy pattern has one.
  optional: Uint8Array;
  // Text every match starts and ends with, and the fewest characters it has, for a quick no.
  prefix: string;
  suffix: string;
  minLength: number;
}

function nothingToRepeat(pattern: string): SyntaxError {
  return new SyntaxError(`usabl cannot build the glob ${JSON.stringify(pattern)}: a ? has nothing before it to repeat`);
}

function compileAnyDepth(pattern: string): AnyDepthProgram {
  const kinds: number[] = [];
  const chars: number[] = [];
  const optional: number[] = [];
  // How many `?` follow each step. The regular expression allowed two after a character and one
  // after a star, and refused to build with more, so this does too.
  const questions: number[] = [];
  let i = 0;
  while (i < pattern.length) {
    const char = pattern.charCodeAt(i);
    if (char === QUESTION) {
      const last = kinds.length - 1;
      const count = (questions[last] ?? 0) + 1;
      if (last < 0 || count > (kinds[last] === LITERAL ? 2 : 1)) throw nothingToRepeat(pattern);
      questions[last] = count;
      if (kinds[last] === LITERAL) optional[last] = 1;
      i += 1;
      continue;
    }
    let kind = LITERAL;
    let width = 1;
    if (char === 0x2a) {
      if (pattern.charCodeAt(i + 1) === 0x2a) {
        kind = DOUBLE_STAR;
        width = pattern.charCodeAt(i + 2) === SLASH ? 3 : 2;
      } else {
        kind = STAR;
      }
    } else if (char === 0) {
      kind = DOUBLE_STAR;
    }
    kinds.push(kind);
    chars.push(kind === LITERAL ? char : 0);
    optional.push(0);
    questions.push(0);
    i += width;
  }
  const required = (index: number): boolean => kinds[index] === LITERAL && optional[index] === 0;
  let start = 0;
  while (start < kinds.length && required(start)) start += 1;
  let end = kinds.length;
  while (end > start && required(end - 1)) end -= 1;
  const text = (from: number, to: number): string =>
    chars
      .slice(from, to)
      .map((code) => String.fromCharCode(code))
      .join('');
  let minLength = 0;
  for (let index = 0; index < kinds.length; index += 1) if (required(index)) minLength += 1;
  return {
    kinds: Uint8Array.from(kinds),
    chars: Uint16Array.from(chars),
    optional: Uint8Array.from(optional),
    prefix: text(0, start),
    suffix: text(end, kinds.length),
    minLength,
  };
}

// Scratch space for runAnyDepth, grown as needed. Matching is synchronous, so one set is enough.
let marks = new Int32Array(64);
let listA = new Int32Array(64);
let listB = new Int32Array(64);
let generation = 0;

function ensureScratch(size: number): void {
  if (marks.length < size) {
    marks = new Int32Array(size);
    listA = new Int32Array(size);
    listB = new Int32Array(size);
    generation = 0;
  }
  if (generation > 0x7fff0000) {
    marks.fill(0);
    generation = 0;
  }
}

// Runs the steps over the path once, keeping the set of steps a match can be at. Each character
// moves every step in the set at most once, so the time is at most steps times characters.
//
// With `underEveryFolder`, the pattern may start at the start of the path or right after any
// slash, as if it were tested against every tail of the path. The start step joins the set at each
// of those places, so the path is still read once.
function runAnyDepth(program: AnyDepthProgram, file: string, budget: GlobMatchBudget | undefined, underEveryFolder: boolean): boolean {
  if (budget !== undefined) budget.charge(1 + program.prefix.length + program.suffix.length);
  if (file.length < program.minLength || (!underEveryFolder && !file.startsWith(program.prefix)) || !file.endsWith(program.suffix)) {
    return false;
  }
  const { kinds, chars, optional } = program;
  const last = kinds.length;
  ensureScratch(last + 1);
  let current = listA;
  let next = listB;
  let size = 0;
  // Adds a step and every step after it that the match can reach without reading a character.
  const add = (from: number, into: Int32Array, count: number): number => {
    let step = from;
    let length = count;
    while (marks[step] !== generation) {
      marks[step] = generation;
      into[length] = step;
      length += 1;
      if (step === last || (kinds[step] === LITERAL && optional[step] === 0)) break;
      step += 1;
    }
    return length;
  };
  generation += 1;
  size = add(0, current, 0);
  for (let position = 0; position < file.length; position += 1) {
    const char = file.charCodeAt(position);
    if (budget !== undefined) budget.charge(size + 1);
    generation += 1;
    let nextSize = 0;
    for (let index = 0; index < size; index += 1) {
      const step = current[index] ?? last;
      if (step === last) continue;
      const kind = kinds[step];
      if (kind === DOUBLE_STAR || (kind === STAR && char !== SLASH)) {
        nextSize = add(step, next, nextSize);
      } else if (kind === LITERAL && chars[step] === char) {
        nextSize = add(step + 1, next, nextSize);
      }
    }
    if (underEveryFolder && char === SLASH) nextSize = add(0, next, nextSize);
    if (nextSize === 0) {
      if (!underEveryFolder) return false;
      // Nothing can match until the next slash starts the pattern again.
      const slash = file.indexOf('/', position + 1);
      if (slash === -1) return false;
      position = slash - 1;
    }
    const swap = current;
    current = next;
    next = swap;
    size = nextSize;
  }
  return marks[last] === generation;
}

/** Thrown when a match needs more work than the budget it was given has left. */
export class GlobBudgetExhausted extends Error {
  constructor(readonly steps: number) {
    super(`usabl used its budget of ${String(steps)} glob matching steps before it finished`);
    this.name = 'GlobBudgetExhausted';
  }
}

/**
 * The work glob matching may do, in steps, shared by every match that is given it. A step is one
 * pattern position tested at one path position, so a match costs at most its pattern's length
 * times its path's length. A caller makes one budget for a run and hands it to each matcher. Once
 * the budget is spent, every match given it throws GlobBudgetExhausted, and the caller reads the
 * file as one it could not place. The count depends only on the patterns and the paths, never on
 * the clock, so the same input runs out at the same file every time.
 */
export class GlobMatchBudget {
  remaining: number;

  constructor(readonly steps: number) {
    this.remaining = steps;
  }

  get exhausted(): boolean {
    return this.remaining < 0;
  }

  charge(steps: number): void {
    this.remaining -= steps;
    if (this.remaining < 0) throw new GlobBudgetExhausted(this.steps);
  }
}

/**
 * The glob matching steps one planner may spend in a run. The worst shapes ran at 20 to 35 million
 * steps a second on a loaded 8-core machine, so the budget is about 3 to 5 seconds of matching at
 * most, far inside a Stop hook's limit. A normal run spends far less: 20,000 changed files against
 * four common globs took about 3 million steps.
 */
export const RUN_GLOB_MATCH_STEPS = 100_000_000;

export interface GlobOptions {
  // False: a wildcard never matches a name that starts with a dot, the rule Node's fs.glob uses.
  // A dot written in the pattern itself still matches. The default, true, is the planner's rule.
  dot?: boolean;
  // Charged for the work of every match. Without one, a match costs what it costs.
  budget?: GlobMatchBudget;
  // True: the pattern matches a path when it matches the path itself or the part after any slash,
  // as if tested against every tail, in one read of the path. Only with the default dot rule.
  underEveryFolder?: boolean;
}

// One part of a pattern read with Node's dot rule. `**` alone in a part matches whole parts of the
// path: zero or more when more of the pattern follows, one or more when it ends the pattern. Each
// part it skips is a name that is not empty and does not start with a dot.
type DotRulePart =
  | { kind: 'any-parts'; last: boolean }
  | { kind: 'name'; matches: (name: string) => boolean; dotGuard: boolean; length: number };

function compileWithDotRule(pattern: string): DotRulePart[] {
  const parts = pattern.split('/');
  return parts.map((part, index) => {
    if (part === '**') return { kind: 'any-parts', last: index === parts.length - 1 };
    // Every other character stands for itself here, `?` too, and a run of stars is one star.
    return { kind: 'name', matches: wildcardNameMatcher(part), dotGuard: !part.startsWith('.'), length: part.length };
  });
}

function skippable(name: string): boolean {
  return name.length > 0 && name.charCodeAt(0) !== 0x2e;
}

// Walks the pattern's parts over the path's parts, keeping the set of path positions a match can
// be at. Each step costs at most one name match for each path part. A name match is charged its
// part's length times the name's length, the most it can cost.
function runWithDotRule(parts: readonly DotRulePart[], file: string, budget: GlobMatchBudget | undefined): boolean {
  if (budget !== undefined) budget.charge(file.length + 1);
  const names = file.split('/');
  const count = names.length;
  let reach = new Uint8Array(count + 1);
  reach[0] = 1;
  for (const part of parts) {
    const next = new Uint8Array(count + 1);
    let any = false;
    if (part.kind === 'any-parts') {
      if (budget !== undefined) budget.charge(count + 1);
      if (part.last) {
        // One or more skippable parts to the end of the path.
        let skippableToEnd = true;
        for (let at = count - 1; at >= 0; at -= 1) {
          skippableToEnd = skippableToEnd && skippable(names[at] ?? '');
          if (skippableToEnd && reach[at] === 1) return true;
        }
        return false;
      }
      let carry = false;
      for (let at = 0; at <= count; at += 1) {
        carry = reach[at] === 1 || (carry && at > 0 && skippable(names[at - 1] ?? ''));
        if (carry) {
          next[at] = 1;
          any = true;
        }
      }
    } else {
      for (let at = 0; at < count; at += 1) {
        if (reach[at] !== 1) continue;
        const name = names[at] ?? '';
        if (budget !== undefined) budget.charge((part.length + 1) * (name.length + 1));
        if (part.dotGuard && name.charCodeAt(0) === 0x2e) continue;
        if (part.matches(name)) {
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

/**
 * A compiled matcher for one pattern, for callers that test many files against it. It gives the
 * same answers as matchGlob.
 */
export function globMatcher(pattern: string, options: GlobOptions = {}): (file: string) => boolean {
  const expansions = pattern.includes('{') ? expandBraces(pattern) : [pattern];
  // A pattern this unit cannot expand falls back to literal-brace matching, which is the
  // prior behavior. The config-load guard refuses such patterns before a run reaches here.
  const patterns = expansions ?? [pattern];
  const { budget } = options;
  if (options.dot === false) {
    if (options.underEveryFolder === true) throw new Error('underEveryFolder needs the default dot rule');
    const compiled = patterns.map(compileWithDotRule);
    return (file: string): boolean => compiled.some((parts) => runWithDotRule(parts, file, budget));
  }
  const underEveryFolder = options.underEveryFolder === true;
  const compiled = patterns.map(compileAnyDepth);
  return (file: string): boolean => compiled.some((program) => runAnyDepth(program, file, budget, underEveryFolder));
}

export function matchGlob(pattern: string, file: string, options: GlobOptions = {}): boolean {
  return globMatcher(pattern, options)(file);
}
