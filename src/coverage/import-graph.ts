/**
 * Import graph discovery for coverage planning.
 * It follows only files that can be proven to exist on disk.
 * It must never guess alias config or pick between candidate files.
 * `unresolvable` records incomplete graph evidence, not a coverage gap by itself.
 */
// Use POSIX paths so coverage keys stay stable across operating systems.
import { builtinModules } from 'node:module';
import { posix as path } from 'node:path';
import type { FsGlob } from '../contracts/index.js';
import {
  braceRangeIn,
  countBraceExpansions,
  expandBraces,
  GlobBudgetExhausted,
  globMatcher,
  type GlobMatchBudget,
  UNSUPPORTED_GLOB_CHARACTERS,
} from '../primitives/match-glob.js';
import { globListBoundProblem } from '../intake/glob-list-bounds.js';
import { commentRanges, syntaxForFile } from '../primitives/source-ast.js';
import {
  type AliasConfig,
  isAliasLikeSpecifier,
  resolveAliasSpecifierEachWay,
} from './alias-config.js';

const NO_ALIASES: AliasConfig = { mappings: [], hasAliasConfig: false };

export type UnresolvableImport =
  | {
      importer: string;
      specifier: string;
      kind: 'alias-unconfigured' | 'alias-unmapped' | 'file-not-found';
    }
  | {
      importer: string;
      specifier: string;
      // More than one file could be what the import loads. usabl does not pick one.
      kind: 'ambiguous-candidates';
      // Every candidate that exists, sorted.
      candidates: string[];
    }
  | {
      importer: string;
      specifier: string;
      // The alias configs usabl reads map the import to more than one place, and usabl cannot
      // tell which one the build uses. Every file found is linked.
      kind: 'alias-conflict';
      // Each path the import resolves to, sorted.
      targets: string[];
      // Every file found at those paths, sorted.
      candidates: string[];
    }
  | {
      importer: string;
      // The call as written, shortened, for the reason text.
      specifier: string;
      // An import.meta.glob or import.meta.globEager call. Vite loads every file its patterns
      // match, and usabl does not follow them.
      kind: 'glob-import';
      // The patterns, written relative to the repository root, sorted. Null when usabl could not
      // read them, which means the call may load any file.
      patterns: string[] | null;
      // The patterns that start with /, without the /, sorted. Vite reads such a pattern from its
      // root, and usabl cannot know that folder, so each is read under every folder: it covers a
      // file when the file's path below some folder at or above it matches. Absent when there is
      // none.
      underEveryFolder?: string[];
      // Why the patterns are null: the argument is not a string or a list of strings, the
      // options set `base`, a pattern starts in a way usabl cannot resolve, a pattern has a
      // part usabl cannot read exactly (see braceAlternatives), the patterns are past the size
      // bounds of the policy glob lists (see globListBoundProblem), or the run's patterns are past
      // its character budget (see GlobImportBudget). Absent otherwise.
      unread?: 'argument' | 'base' | 'start' | 'pattern' | 'size' | 'budget';
      // The patterns, as written, that hold syntax the glob matcher does not evaluate, such as a
      // character class. Each is read as every file in the folder above that syntax, sorted.
      // Absent when there is none.
      widened?: string[];
    }
  | {
      importer: string;
      // The call as written, shortened, for the reason text.
      specifier: string;
      // An import() or require() whose path is built at run time, so usabl cannot follow it.
      kind: 'dynamic-import';
      // The fixed start of the path, written relative to the repository root, sorted. The call
      // may load any file whose path starts with one of them. Null when the path has no fixed
      // start usabl can resolve, which means the call may load any file.
      prefixes: string[] | null;
      // A bare fixed start that no package explains, such as `tests/` in import(`tests/${name}`).
      // It may be an alias usabl did not read, so the call may load any file a path segment of
      // which starts with it. Absent when there is none.
      nameStarts?: string[];
    }
  | {
      importer: string;
      specifier: string;
      // A bare import that no package explains: a `#` specifier, which package.json "imports"
      // maps, or a name no package.json usabl reads declares and that is not a Node.js built-in
      // module. It may be an alias usabl did not read, so it may load a file its last segment
      // names. Recorded only by the complete reading.
      kind: 'bare-unknown';
    }
  | {
      importer: string;
      specifier: string;
      // A bare import of a path inside a workspace package, such as '@acme/ui/testing', that usabl
      // does not follow by path: the package has an "exports" field, which usabl does not read, or
      // no file under the package folder has that path. It may load any file of the package.
      // Recorded only by the complete reading.
      kind: 'package-subpath';
      // The package folder, relative to the repository root. Null when the path leaves that
      // folder, such as '@acme/ui/../other/x', which may then load any file.
      packageDir: string | null;
    }
  | {
      importer: string;
      // Empty: the entry is about the whole file, not one import in it.
      specifier: string;
      // A file usabl did not read for imports, because it is longer than MAX_SOURCE_CHARACTERS or
      // has a line longer than MAX_SOURCE_LINE_CHARACTERS. Its imports are unknown, so it may load
      // any file.
      kind: 'unread-source';
      why: 'size' | 'line';
    }
  | {
      importer: string;
      specifier: string;
      // A bare import, such as 'tests/Widget', that the tsconfig baseUrl resolves to a file in
      // the repository. The compiler reads baseUrl, but a bundler reads it only with a plugin, and
      // usabl cannot tell which one this build uses. So the import is not followed.
      kind: 'base-url';
      // Every file the import resolves to under a baseUrl, sorted.
      candidates: string[];
    };

/**
 * How much of a file's source the graph reads as imports.
 *
 * The default reads static imports on one line and dynamic imports of a fixed path. It maps
 * changed files to screens, and an import it misses leaves a file unmapped, which is a gap.
 *
 * `complete` also reads imports across several lines, re-exports, imports for side effects,
 * require() of a fixed path, bare imports a configured alias maps, and bare imports under a
 * tsconfig baseUrl. The planner uses it to ask whether any screen could load a test file. There an
 * import it misses would read as "nothing loads this file" and exclude it, so it reads more and may
 * link a file that only a string names. That can only make a test file count as a UI file.
 */
export interface ImportGraphOptions {
  complete?: boolean;
  // The folders bare imports resolve under, from the tsconfig baseUrl. Read only when complete.
  baseUrlDirs?: readonly string[];
  // The package names a bare import may name (see declaredPackageNames). Read only when complete.
  // When given, a bare import no package explains is recorded as `bare-unknown`.
  declaredPackages?: readonly string[];
  // The workspace packages, by name and folder, and whether each has an exports field. A bare
  // import of a path inside one, such as '@acme/ui/src/tests/helpers', is followed to the file it
  // names under the package folder when the package has no exports field. It is recorded as
  // `package-subpath` when it names no file, or when the package has an exports field, which the
  // resolver reads in place of the folder layout. With an exports field, a subpath whose key is in
  // `exactExports` is followed to the one file that entry names, when that file is inside the
  // package folder. Read only when complete.
  workspacePackages?: readonly WorkspacePackageView[];
  // The run's budget of import.meta.glob pattern characters. A call past it may load any file.
  globImports?: GlobImportBudget;
}

// What the graph reads of a workspace package (see WorkspacePackage in workspace-packages.ts).
interface WorkspacePackageView {
  name: string;
  dir: string;
  hasExports: boolean;
  exactExports?: Readonly<Record<string, string>>;
  exportKeys?: readonly string[];
  leavingExportKeys?: readonly string[];
}

// The exports keys a subpath key such as ./testing matches: the key itself when exports has it, as
// Node.js picks an exact key first. Otherwise every pattern key with one * whose text before and
// after the * the subpath starts and ends with, and every folder key, one that ends with /, that the
// subpath starts with. Node.js removed folder keys, but a bundler such as Vite still reads one and
// appends the rest of the subpath to its target.
function matchedExportKeys(keys: readonly string[], key: string): string[] {
  if (keys.includes(key)) return [key];
  return keys.filter((candidate) => {
    if (candidate.endsWith('/') && key.startsWith(candidate)) return true;
    const star = candidate.indexOf('*');
    if (star === -1 || candidate.indexOf('*', star + 1) !== -1) return false;
    const before = candidate.slice(0, star);
    const after = candidate.slice(star + 1);
    return key.length >= before.length + after.length && key.startsWith(before) && key.endsWith(after);
  });
}

export interface ImportGraphView {
  get(file: string): string[];
  unresolvable: UnresolvableImport[];
  visited: ReadonlySet<string>;
}

// The static imports of a file: `import`, white space, an optional `type` and white space, then
// one or more characters on the same line that are not a quote or a semicolon, white space, `from`,
// any white space, and a quoted path. A multiline static import can be missed, which under-reports
// edges. Under-reporting is safer here because discovery must never invent import edges that were
// not proven by concrete source text and files.
//
// This reads what the pattern below reads, match for match, in time that grows with the length of
// the text. The pattern itself took time that grew with the square of a line's length, so one
// long line could hold a check for minutes. The pattern stays here as the definition, and the
// tests compare the two on generated text.
//   /\bimport\s+(?:type\s+)?[^"'`;\n]+?\sfrom\s*["'`]([^"'`]+)["'`]/g
export function staticImportSpecifiers(source: string): string[] {
  const found: string[] = [];
  let at = source.indexOf('import');
  if (at === -1) return found;
  const scan = new StaticImportScan(source);
  while (at !== -1) {
    const match = at === 0 || !isWordCode(source.charCodeAt(at - 1)) ? scan.matchAt(at) : null;
    if (match === null) {
      at = source.indexOf('import', at + 1);
      continue;
    }
    found.push(source.slice(match.open + 1, match.close));
    at = source.indexOf('import', match.close + 1);
  }
  return found;
}

// JavaScript's \s, which also takes the Unicode space characters, the line separators, and the
// byte order mark.
function isSpaceCode(code: number): boolean {
  return (
    (code >= 9 && code <= 13) ||
    code === 32 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

// A character of \w, as \b reads it.
function isWordCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isQuoteCode(code: number): boolean {
  return code === 34 || code === 39 || code === 96;
}

// A character the part between the import and `from` may hold: not a quote, a semicolon, or \n.
function isClauseCode(code: number): boolean {
  return !isQuoteCode(code) && code !== 59 && code !== 10;
}

/**
 * What the scan works out once for the whole text, from the end to the start: where each run of
 * clause characters ends, and the first place at or after each position where white space,
 * `from`, any white space, and a quoted path start. A start then needs only a few lookups for each
 * way the pattern could split its white space, and each run of white space is walked once.
 */
class StaticImportScan {
  private readonly clauseEnd: Int32Array;
  private readonly nextFrom: Int32Array;
  // For each place `from` starts a path, where the path's quotes are.
  private readonly paths = new Map<number, { open: number; close: number }>();

  constructor(private readonly source: string) {
    const length = source.length;
    this.clauseEnd = new Int32Array(length + 2);
    this.nextFrom = new Int32Array(length + 2);
    this.clauseEnd[length] = length;
    this.clauseEnd[length + 1] = length;
    this.nextFrom[length] = length;
    this.nextFrom[length + 1] = length;
    for (let index = length - 1; index >= 0; index -= 1) {
      this.clauseEnd[index] = isClauseCode(source.charCodeAt(index)) ? this.clauseEnd[index + 1]! : index;
      this.nextFrom[index] = this.fromPath(index) ? index : this.nextFrom[index + 1]!;
    }
  }

  // Whether white space at `at` is followed by `from`, any white space, and a quoted path with at
  // least one character before the next quote. Each `from` is read once, and each path's text is
  // walked once, so this costs the length of the text in all.
  private fromPath(at: number): boolean {
    const source = this.source;
    if (!isSpaceCode(source.charCodeAt(at)) || !source.startsWith('from', at + 1)) return false;
    let open = at + 5;
    while (open < source.length && isSpaceCode(source.charCodeAt(open))) open += 1;
    if (open >= source.length || !isQuoteCode(source.charCodeAt(open))) return false;
    let close = open + 1;
    while (close < source.length && !isQuoteCode(source.charCodeAt(close))) close += 1;
    if (close >= source.length || close === open + 1) return false;
    this.paths.set(at, { open, close });
    return true;
  }

  // The path the pattern matches when its lazy part starts at `start`, whose clause characters end
  // at `end`: the first `from` path after at least one character, or null.
  private tryStart(start: number, end: number): { open: number; close: number } | null {
    const from = this.nextFrom[start + 1]!;
    return from < this.source.length && from <= end ? (this.paths.get(from) ?? null) : null;
  }

  /**
   * The match of the pattern that starts at `at`, where `import` is, or null. The pattern takes
   * its white space and its `type` in the order the pattern's own matching tries them: first all
   * the white space, with `type` and then each shorter run of the white space after it, then all
   * the white space without `type`, then each shorter run of the white space after the import. A
   * lazy part that starts inside white space ends at the first \n in it, since \n is not a clause
   * character.
   */
  matchAt(at: number): { open: number; close: number } | null {
    const source = this.source;
    const afterImport = at + 6;
    if (afterImport >= source.length || !isSpaceCode(source.charCodeAt(afterImport))) return null;
    let word = afterImport;
    while (word < source.length && isSpaceCode(source.charCodeAt(word))) word += 1;
    if (source.startsWith('type', word) && word + 4 < source.length && isSpaceCode(source.charCodeAt(word + 4))) {
      let after = word + 4;
      while (after < source.length && isSpaceCode(source.charCodeAt(after))) after += 1;
      const found = this.tryWithin(word + 5, after);
      if (found !== null) return found;
    }
    return this.tryWithin(afterImport + 1, word);
  }

  // Tries each start from `last` down to `first`, where [first, last) is white space and `last` is
  // the first character after it.
  private tryWithin(first: number, last: number): { open: number; close: number } | null {
    const atLast = this.tryStart(last, this.clauseEnd[last]!);
    if (atLast !== null) return atLast;
    let newline = -1;
    for (let start = last - 1; start >= first; start -= 1) {
      if (this.source.charCodeAt(start) === 10) newline = start;
      const found = this.tryStart(start, newline === -1 ? this.clauseEnd[last]! : newline);
      if (found !== null) return found;
    }
    return null;
  }
}
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
// Candidate suffixes for an extensionless import, split into a file tier and a directory-index
// tier. The list is fixed: Vite's default JS and TS extensions, plus .vue and .svelte, which a
// project can add to resolve.extensions. usabl does not read resolve.extensions from the Vite
// config, because it cannot run the config, and a partial read that missed an extension would be
// worse than a list that may hold too many. The bundler's exact pick depends on that order, so
// when more than one candidate exists in a tier we link all of them and disclose the ambiguity
// instead of guessing. Guessing, or linking none, could leave a screen that renders the changed
// file out of the scan.
const EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.vue', '.svelte'];
const FILE_SUFFIXES = EXTENSIONS;
const INDEX_SUFFIXES = EXTENSIONS.map((extension) => `/index${extension}`);

function extractSpecifiers(source: string): string[] {
  const found: string[] = [];
  found.push(...staticImportSpecifiers(source));
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) {
    const [, specifier] = match;
    // A template literal with a ${...} part is a path built at run time, not a file name. It is
    // recorded as a dynamic import instead (see findLoaderCalls).
    if (typeof specifier === 'string' && !specifier.includes('${')) {
      found.push(specifier);
    }
  }
  return found;
}

// The complete reading. `from '...'` matches a static import or a re-export on one line or across
// several, and `import '...'` an import for its side effects. Either can match text that only looks
// like an import, which links a file usabl did not need to, the safe direction for this reading.
const FROM_ANYWHERE_RE = /\bfrom\s*(["'`])([^"'`\n]+)\1/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport\s*(["'`])([^"'`\n]+)\1/g;

function extractEverySpecifier(source: string, calls: readonly LoaderCall[]): string[] {
  const found = new Set<string>(extractSpecifiers(source));
  for (const pattern of [FROM_ANYWHERE_RE, SIDE_EFFECT_IMPORT_RE]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2];
      if (typeof specifier === 'string') found.add(specifier);
    }
  }
  for (const call of calls) {
    if (call.kind === 'literal') found.add(call.path);
  }
  return [...found];
}

// ---- loads usabl cannot follow ----
//
// Three ways to load a module leave no import usabl can resolve: an import.meta.glob call, an
// import() or require() whose path is built at run time, and a bare import that only a tsconfig
// baseUrl resolves. The graph does not follow them. It records each one in `unresolvable`, with
// the files it may load, so the planner can tell a test file that nothing loads from one that a
// screen may load in a way usabl cannot see.

// The longest call text a reason quotes.
const MAX_CALL_TEXT = 80;

const GLOB_CALL_RE = /\bimport\.meta\.glob(?:Eager)?(?![\w$])/g;
const DYNAMIC_CALL_RE = /(?<![\w$.])(?:import|require)\s*\(/g;

/**
 * The first place at or after `from` where `text` starts in the file, or -1. A file with many
 * loader calls asks the same question from many places, such as where a comment or a call closes,
 * and a search from each call to the end of a file that never closes it would take time that grows
 * with the square of the count. So each answer is kept: it holds for every place from where it was
 * asked up to where it found the text.
 */
type Finder = (text: string, from: number) => number;

function makeFinder(source: string): Finder {
  const known = new Map<string, { from: number; at: number }>();
  return (text, from) => {
    const last = known.get(text);
    if (last !== undefined && from >= last.from && (last.at === -1 || from <= last.at)) return last.at;
    const at = source.indexOf(text, from);
    known.set(text, { from, at });
    return at;
  };
}

// Skips spaces, line breaks, and comments. A comment inside a call, such as a webpack chunk name,
// is common and is not part of the path.
function skipBlank(source: string, from: number, find: Finder): number {
  let index = from;
  for (;;) {
    while (index < source.length && /\s/u.test(source.charAt(index))) index += 1;
    if (source.startsWith('/*', index)) {
      const close = find('*/', index + 2);
      if (close === -1) return source.length;
      index = close + 2;
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = find('\n', index);
      if (end === -1) return source.length;
      index = end + 1;
      continue;
    }
    return index;
  }
}

// A quoted string that starts at `start`, as the string it is: a backslash escape is decoded. A
// template literal with a ${...} part is `interpolated`, and `text` is then the text before it.
// Null when the text there is not a string, or holds an escape this reader does not decode (a
// character code, such as \x41 or A, or an octal digit).
type QuotedString = { text: string; end: number; interpolated: false } | { text: string; interpolated: true };

const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };

function readQuoted(source: string, start: number): QuotedString | null {
  const quote = source.charAt(start);
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let text = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === '\\') {
      const next = source.charAt(index + 1);
      if (next === '' || /[0-9xu]/u.test(next)) return null;
      index += 1;
      // A backslash before a line break continues the string on the next line.
      if (next === '\r' && source.charAt(index + 1) === '\n') index += 1;
      if (next === '\n' || next === '\r') continue;
      text += SIMPLE_ESCAPES[next] ?? next;
      continue;
    }
    if (char === '\n' && quote !== '`') return null;
    if (quote === '`' && char === '$' && source.charAt(index + 1) === '{') {
      return { text, interpolated: true };
    }
    if (char === quote) return { text, end: index + 1, interpolated: false };
    text += char;
  }
  return null;
}

// The call text from `start`, cut at its closing parenthesis when that is near, with every run of
// spaces folded to one, and shortened.
function callText(source: string, start: number): string {
  const window = source.slice(start, start + MAX_CALL_TEXT * 3);
  let depth = 0;
  let end = window.length;
  for (let index = 0; index < window.length; index += 1) {
    const char = window.charAt(index);
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  const text = window.slice(0, end).replace(/\s+/gu, ' ').trim();
  return text.length > MAX_CALL_TEXT ? `${text.slice(0, MAX_CALL_TEXT - 3)}...` : text;
}

// A call usabl found in a file: an import() or require() of a fixed path, one whose path is built
// at run time, or an import.meta.glob call.
type LoaderCall =
  | { kind: 'literal'; path: string }
  | { kind: 'built'; text: string; prefix: string | null }
  // `base` is set when the patterns are null because the options may set base.
  | { kind: 'glob'; text: string; patterns: string[] | null; base?: true };

// The first argument of the import() or require() whose opening parenthesis is at `open`.
function readDynamicCall(source: string, start: number, open: number, find: Finder): LoaderCall {
  const text = callText(source, start);
  const at = skipBlank(source, open + 1, find);
  const quoted = readQuoted(source, at);
  if (quoted === null) return { kind: 'built', text, prefix: null };
  if (quoted.interpolated) return { kind: 'built', text, prefix: quoted.text };
  const after = source.charAt(skipBlank(source, quoted.end, find));
  // A string followed by anything other than the end of the argument, such as + name, is a path
  // built at run time. Only its fixed start would be known, and usabl does not read past a string.
  if (after === ')' || after === ',') return { kind: 'literal', path: quoted.text };
  return { kind: 'built', text, prefix: null };
}

// The options of an import.meta.glob call that usabl reads as setting no `base`: an object whose
// keys are the other options Vite knows, plain or quoted, and whose values are a plain string, a
// number, true, false, or, for query, an object of those. Vite evaluates the options as code, so a
// quoted key, a computed key, or a spread can set base too. Anything else may set it.
// Each run of white space in the pattern is followed by a token that is not white space, and no two
// runs sit side by side, so a failed match backtracks over each run only once. Options text longer
// than MAX_GLOB_OPTIONS_TEXT is not read at all and may set base.
const GLOB_STRING = String.raw`(?:'[^'\\\n]*'|"[^"\\\n]*")`;
const GLOB_VALUE = String.raw`(?:true|false|-?\d+(?:\.\d+)?|${GLOB_STRING})`;
const GLOB_QUERY_ENTRY = String.raw`(?:[A-Za-z_$][\w$]*|${GLOB_STRING})\s*:\s*${GLOB_VALUE}`;
const GLOB_QUERY = String.raw`\{\s*(?:${GLOB_QUERY_ENTRY}(?:\s*,\s*${GLOB_QUERY_ENTRY})*\s*(?:,\s*)?)?\}`;
const GLOB_KEY = String.raw`(?:(?:eager|import|query|as|exhaustive)|'(?:eager|import|query|as|exhaustive)'|"(?:eager|import|query|as|exhaustive)")`;
const GLOB_ENTRY = String.raw`${GLOB_KEY}\s*:\s*(?:${GLOB_VALUE}|${GLOB_QUERY})`;
const OPTIONS_WITHOUT_BASE_RE = new RegExp(
  String.raw`^,\s*(?:\{\s*(?:${GLOB_ENTRY}(?:\s*,\s*${GLOB_ENTRY})*\s*(?:,\s*)?)?\}\s*(?:,\s*)?)?$`,
  'u',
);
// The longest options text usabl reads. Real options are a few dozen characters.
export const MAX_GLOB_OPTIONS_TEXT = 1000;

function optionsSetNoBase(options: string): boolean {
  return options.length <= MAX_GLOB_OPTIONS_TEXT && OPTIONS_WITHOUT_BASE_RE.test(options);
}

// The patterns of the import.meta.glob call that starts at `start`: one string or a list of
// strings. Null when the argument is anything else, or when the options may set `base`, which
// moves where relative patterns start.
function readGlobCall(source: string, start: number, nameEnd: number, find: Finder): LoaderCall {
  const text = callText(source, start);
  let at = skipBlank(source, nameEnd, find);
  // A type argument, such as import.meta.glob<Module>('./x/*.ts').
  if (source.charAt(at) === '<') {
    const close = find('>', at);
    if (close === -1) return { kind: 'glob', text, patterns: null };
    at = skipBlank(source, close + 1, find);
  }
  if (source.charAt(at) !== '(') return { kind: 'glob', text, patterns: null };
  at = skipBlank(source, at + 1, find);
  const patterns: string[] = [];
  const readOne = (from: number): number | null => {
    const quoted = readQuoted(source, from);
    if (quoted === null || quoted.interpolated) return null;
    patterns.push(quoted.text);
    return skipBlank(source, quoted.end, find);
  };
  if (source.charAt(at) === '[') {
    at = skipBlank(source, at + 1, find);
    for (;;) {
      if (source.charAt(at) === ']') break;
      const next = readOne(at);
      if (next === null) return { kind: 'glob', text, patterns: null };
      if (source.charAt(next) === ',') {
        at = skipBlank(source, next + 1, find);
        continue;
      }
      if (source.charAt(next) !== ']') return { kind: 'glob', text, patterns: null };
      at = next;
      break;
    }
    at = skipBlank(source, at + 1, find);
  } else {
    const next = readOne(at);
    if (next === null) return { kind: 'glob', text, patterns: null };
    at = next;
  }
  if (source.charAt(at) === ')') return { kind: 'glob', text, patterns };
  if (source.charAt(at) !== ',') return { kind: 'glob', text, patterns: null };
  const close = find(')', at);
  const options = source.slice(at, close === -1 ? source.length : close);
  return optionsSetNoBase(options) ? { kind: 'glob', text, patterns } : { kind: 'glob', text, patterns: null, base: true };
}

// A webpack require.context(folder, recursive, pattern) call. It loads files under the folder, so
// the folder is the fixed start of what it may load. Its other arguments only narrow that set, so
// they are not read. A first argument that is not a string may point anywhere.
function readContextCall(source: string, start: number, open: number, find: Finder): LoaderCall {
  const text = callText(source, start);
  const quoted = readQuoted(source, skipBlank(source, open + 1, find));
  if (quoted === null || quoted.interpolated) return { kind: 'built', text, prefix: quoted === null ? null : quoted.text };
  const after = source.charAt(skipBlank(source, quoted.end, find));
  if (after !== ')' && after !== ',') return { kind: 'built', text, prefix: null };
  return { kind: 'built', text, prefix: quoted.text.endsWith('/') ? quoted.text : `${quoted.text}/` };
}

const CONTEXT_CALL_RE = /(?<![\w$.])require\s*\.\s*context\s*\(/g;

// A call and the offset where it starts.
type FoundCall = LoaderCall & { at: number };

function findLoaderCalls(source: string): FoundCall[] {
  const calls: FoundCall[] = [];
  const find = makeFinder(source);
  for (const match of source.matchAll(GLOB_CALL_RE)) {
    calls.push({ ...readGlobCall(source, match.index, match.index + match[0].length, find), at: match.index });
  }
  for (const match of source.matchAll(DYNAMIC_CALL_RE)) {
    calls.push({ ...readDynamicCall(source, match.index, match.index + match[0].length - 1, find), at: match.index });
  }
  for (const match of source.matchAll(CONTEXT_CALL_RE)) {
    calls.push({ ...readContextCall(source, match.index, match.index + match[0].length - 1, find), at: match.index });
  }
  return calls;
}

// The loader calls of a file outside its comments. The file is parsed to find the comments, so a
// string that holds comment marks, such as "http://", never hides a call. A file that does not parse,
// such as a .vue file, keeps every call: when in doubt, the call counts.
function findLoaderCallsInCode(source: string, file: string): FoundCall[] {
  const calls = findLoaderCalls(source);
  if (calls.length === 0) return calls;
  const comments = commentRanges(source, syntaxForFile(file));
  if (comments === null) return calls;
  const inComment = commentLookup(comments);
  return calls.filter((call) => !inComment(call.at));
}

/**
 * Whether a place in the file is inside one of the comments. The comments are joined where they
 * touch or overlap and sorted once, and each place is found by halving, so a file with many calls
 * and many comments does not test every call against every comment.
 */
function commentLookup(comments: ReadonlyArray<{ start: number; end: number }>): (at: number) => boolean {
  const sorted = comments.filter((comment) => comment.end > comment.start).sort((a, b) => a.start - b.start);
  const starts: number[] = [];
  const ends: number[] = [];
  for (const comment of sorted) {
    const last = ends.length - 1;
    if (last >= 0 && comment.start <= ends[last]!) {
      ends[last] = Math.max(ends[last]!, comment.end);
    } else {
      starts.push(comment.start);
      ends.push(comment.end);
    }
  }
  return (at) => {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (starts[middle]! <= at) low = middle + 1;
      else high = middle - 1;
    }
    return high >= 0 && at < ends[high]!;
  };
}

// What the graph knows when it reads a load: the aliases, the baseUrl folders, and, in the
// complete reading, the package names a bare import may name. `packages` is null in the default
// reading, where every bare name is read as a package, as it always was.
interface LoadContext {
  aliases: AliasConfig;
  baseUrlDirs: readonly string[];
  packages: ReadonlySet<string> | null;
  // Whether a glob pattern that starts with / is read under every folder. The complete reading does
  // this. Otherwise such a pattern may load any file.
  rootedUnderEveryFolder: boolean;
  globImports: GlobImportBudget | undefined;
}

const BUILTIN_MODULES: ReadonlySet<string> = new Set(builtinModules);
// Built-ins that exist only with the node: prefix, which some Node.js versions leave out of
// builtinModules.
const NODE_SCHEME_ONLY_MODULES: ReadonlySet<string> = new Set(['sea', 'sqlite', 'test', 'test/reporters']);

// The package name of a bare specifier: its first segment, or its first two for a scoped name.
function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  return segments.slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
}

// Whether a whole specifier is a Node.js built-in module, such as fs, fs/promises, or node:test.
// The first segment is not enough: util/tests/Widget is not the built-in util, and an alias usabl
// does not read may map util to a folder of the app. The subpaths that are built-ins come from the
// same list.
function isBuiltinModule(specifier: string): boolean {
  if (BUILTIN_MODULES.has(specifier)) return true;
  if (!specifier.startsWith('node:')) return false;
  const name = specifier.slice('node:'.length);
  return BUILTIN_MODULES.has(name) || NODE_SCHEME_ONLY_MODULES.has(name);
}

/**
 * Whether no package explains a bare import, so it may load a file of the app through a loader
 * usabl did not read: a `#` specifier, which package.json "imports" maps and which is never an npm
 * package, or a name that is neither a Node.js built-in module nor a package a package.json usabl
 * reads declares. Always false in the default reading.
 */
function unexplainedBare(written: string, packages: ReadonlySet<string> | null): boolean {
  // A query or hash is not part of the package name, so lodash?x and lodash#x name lodash.
  const specifier = withoutQueryOrHash(written);
  if (packages === null) return false;
  if (specifier.startsWith('#')) return true;
  return !isBuiltinModule(specifier) && !packages.has(packageNameOf(specifier));
}

// Whether the fixed start of a bare path names a whole package that explains it, such as
// `@patternfly/react-icons/dist/` for a declared @patternfly/react-icons. A start that ends inside
// the package name, such as `@patternfly/` or `te`, may still become any name. A built-in module
// does not count, because the rest of the path is not known, so the whole specifier cannot be
// checked against the list of built-ins.
function startNamesKnownPackage(start: string, packages: ReadonlySet<string> | null): boolean {
  if (packages === null) return true;
  const segments = start.split('/');
  const nameSegments = start.startsWith('@') ? 2 : 1;
  if (segments.length <= nameSegments) return false;
  const name = segments.slice(0, nameSegments).join('/');
  return !start.startsWith('#') && packages.has(name);
}

// Whether a loader's start is bare: not relative, not rooted, not one that can still become either,
// and not an alias usabl reads or an alias-like start.
function isBareStart(text: string, aliases: AliasConfig): boolean {
  if (text.startsWith('./') || text.startsWith('../') || text.startsWith('/')) return false;
  if (text === '' || text === '.' || text === '..' || text === '@' || text === '~') return false;
  return resolveAliasSpecifierEachWay(text, aliases).length === 0 && !isAliasLikeSpecifier(text);
}

// A path the start of a loader names, written relative to the repository root: a relative path
// from the importer's folder, a path through a configured alias, or a path under a baseUrl. An
// empty list means a package. Null means usabl cannot tell where it points, so it may be any file.
function resolveLoaderPaths(
  importer: string,
  text: string,
  aliases: AliasConfig,
  baseUrlDirs: readonly string[],
  form: 'glob' | 'prefix',
): string[] | null {
  if (text.startsWith('./') || text.startsWith('../')) {
    return [path.normalize(path.join(path.dirname(importer), text))];
  }
  // The start can still become ./, ../, @/, ~/, or /, so it may point anywhere.
  if (text === '' || text === '.' || text === '..' || text === '@' || text === '~' || text.startsWith('/')) {
    return null;
  }
  const throughAlias = resolveAliasSpecifierEachWay(text, aliases);
  if (throughAlias.length > 0) return throughAlias;
  if (isAliasLikeSpecifier(text)) return null;
  const underBaseUrl = baseUrlDirs.map((dir) => path.normalize(path.join(dir, text)));
  // A glob pattern must be relative, rooted, or an alias. A bare one is an alias usabl did not
  // read, unless a baseUrl explains it. A bare path start is a package or a path under a baseUrl.
  if (form === 'glob') return underBaseUrl.length > 0 ? underBaseUrl : null;
  return underBaseUrl;
}

// A pattern the repository's glob matcher reads the same way Vite does. One with syntax the
// matcher does not read, such as a ? or a character class, could match files the matcher misses.
function readableGlob(pattern: string): boolean {
  if (UNSUPPORTED_GLOB_CHARACTERS.some((character) => pattern.includes(character))) return false;
  return braceRangeIn(pattern) === null && expandBraces(pattern) !== null;
}

// The folder above the first segment of a pattern that holds glob syntax, as a pattern for every
// file in it: src/pages/** for src/pages/[id]/*.tsx. Every file the pattern can match is in it.
function folderAbove(pattern: string): string {
  const segments: string[] = [];
  for (const segment of pattern.split('/')) {
    if (/[*?[\](){}!]/u.test(segment)) break;
    segments.push(segment);
  }
  return segments.length === 0 ? '**' : `${segments.join('/')}/**`;
}

// The most brace alternatives usabl reads in one pattern. A pattern with more may load any file.
export const MAX_BRACE_ALTERNATIVES = 64;

// How many alternatives the brace groups of a pattern expand to, counted without expanding them, and
// stopped once past the cap so a long pattern costs nothing. A group needs a comma, as in expandBraces.
function braceAlternativeCount(pattern: string): number {
  let count = 1;
  for (const match of pattern.matchAll(/\{([^{}]*)\}/gu)) {
    const body = match[1] ?? '';
    if (body.includes(',')) count *= body.split(',').length;
    if (count > MAX_BRACE_ALTERNATIVES) return count;
  }
  return count;
}

// Whether a `..` comes after a segment with glob syntax, such as ./*/../tests/*.tsx. Which folder
// that names depends on the files the glob part matches, so usabl cannot read it exactly.
function dotDotAfterGlob(pattern: string): boolean {
  const segments = pattern.split('/');
  const first = segments.findIndex((segment) => /[*?[\](){}!]/u.test(segment));
  return first !== -1 && segments.slice(first + 1).includes('..');
}

// The literal alternatives of a pattern's brace groups, so each is resolved and normalized on its
// own: ./{../tests,x}/*.tsx is ../tests/*.tsx and x/*.tsx. Null when usabl cannot read the braces
// exactly: a nested or unbalanced brace, more alternatives than the cap, a .. after a glob segment
// in an alternative, or an escaped brace or comma, such as \{x,tests\}, which the glob reads as
// literal text and usabl would expand.
function braceAlternatives(pattern: string): string[] | null {
  if (/\\[{},]/u.test(pattern)) return null;
  if (!pattern.includes('{') && !pattern.includes('}')) return dotDotAfterGlob(pattern) ? null : [pattern];
  if (braceAlternativeCount(pattern) > MAX_BRACE_ALTERNATIVES) return null;
  const alternatives = expandBraces(pattern);
  if (alternatives === null || alternatives.some(dotDotAfterGlob)) return null;
  return alternatives;
}

// A pattern that starts with /, as the pattern below each folder it is read under: every leading /
// is taken off, since Vite joins the rest to its root and so reads //tests as /tests, and the rest
// is normalized. A leading .. is dropped too. Under a folder F, ../x names x under
// the folder above F, and that folder is also one the pattern is read under, so the pattern
// without the .. covers every file the pattern with it covers.
function belowEveryFolder(pattern: string): string {
  let below = path.normalize(pattern.replace(/^\/+/u, ''));
  while (below === '..' || below.startsWith('../')) below = below.slice(3);
  return below === '' || below === '.' ? '**' : below;
}

function globEntry(importer: string, call: Extract<LoaderCall, { kind: 'glob' }>, context: LoadContext): UnresolvableImport {
  const { aliases, baseUrlDirs, rootedUnderEveryFolder } = context;
  const open = (unread: 'argument' | 'base' | 'start' | 'pattern' | 'size' | 'budget'): UnresolvableImport => ({
    importer,
    specifier: call.text,
    kind: 'glob-import',
    patterns: null,
    unread,
  });
  if (call.patterns === null) return open(call.base === true ? 'base' : 'argument');
  // The patterns come from source code, so they have the bounds of the policy glob lists, counted
  // before anything is expanded. Past one, the call may load any file. A pattern whose braces
  // usabl cannot read, or that has more than the cap of brace alternatives, is left to
  // braceAlternatives below, which reads it as one that may load any file too.
  const positive = call.patterns.filter((candidate) => !candidate.startsWith('!'));
  const expandable = positive.filter((pattern) => {
    const count = countBraceExpansions(pattern);
    return count !== null && count <= MAX_BRACE_ALTERNATIVES;
  });
  if (globListBoundProblem(expandable) !== null) return open('size');
  const resolved: string[] = [];
  const rooted: string[] = [];
  const widened: string[] = [];
  // Each path is read exactly when the glob matcher can, and otherwise as every file in the folder
  // above the syntax it cannot evaluate.
  const add = (into: string[], resolvedPath: string, pattern: string): void => {
    if (readableGlob(resolvedPath)) {
      into.push(resolvedPath);
    } else {
      into.push(folderAbove(resolvedPath));
      widened.push(pattern);
    }
  };
  // A negative pattern only takes files away, so leaving it out can only name more files.
  for (const pattern of positive) {
    // The braces are expanded first, so a .. or an alias inside an alternative is resolved.
    const alternatives = braceAlternatives(pattern);
    if (alternatives === null) return open('pattern');
    for (const alternative of alternatives) {
      // Vite reads a pattern that starts with / from its root. A plugin, the command line, or a
      // config usabl cannot run can set that folder, so usabl reads the pattern under every folder.
      if (alternative.startsWith('/') && rootedUnderEveryFolder) {
        add(rooted, belowEveryFolder(alternative), pattern);
        continue;
      }
      const paths = resolveLoaderPaths(importer, alternative, aliases, baseUrlDirs, 'glob');
      if (paths === null) return open('start');
      for (const resolvedPath of paths) add(resolved, resolvedPath, pattern);
    }
  }
  const patterns = [...new Set(resolved)].sort();
  const underEveryFolder = [...new Set(rooted)].sort();
  const characters = [...patterns, ...underEveryFolder].reduce((sum, pattern) => sum + pattern.length, 0);
  if (context.globImports !== undefined && !context.globImports.fits(importer, call.text, characters)) return open('budget');
  return {
    importer,
    specifier: call.text,
    kind: 'glob-import',
    patterns,
    ...(rooted.length === 0 ? {} : { underEveryFolder }),
    ...(widened.length === 0 ? {} : { widened: [...new Set(widened)].sort() }),
  };
}

// Null when the fixed start names a package, which loads no file of the app. A bare start that no
// package explains may be an alias usabl did not read, so it names files by name, the way an
// unresolved import does: `tests/${name}` may load any file in a folder named tests.
function dynamicEntry(importer: string, call: Extract<LoaderCall, { kind: 'built' }>, context: LoadContext): UnresolvableImport | null {
  const { aliases, baseUrlDirs, packages } = context;
  if (call.prefix === null) {
    return { importer, specifier: call.text, kind: 'dynamic-import', prefixes: null };
  }
  // A query or hash in the fixed start, as in `./tests/Widget?${q}`, is not part of the path, so
  // the start is read without it, as an import is.
  const start = withoutQueryOrHash(call.prefix);
  const prefixes = resolveLoaderPaths(importer, start, aliases, baseUrlDirs, 'prefix');
  const nameStart = start.replace(/^#/u, '');
  const byName = prefixes !== null && isBareStart(start, aliases) && !startNamesKnownPackage(start, packages);
  if (byName && nameStart === '') {
    return { importer, specifier: call.text, kind: 'dynamic-import', prefixes: null };
  }
  if (prefixes !== null && prefixes.length === 0 && !byName) return null;
  return {
    importer,
    specifier: call.text,
    kind: 'dynamic-import',
    prefixes: prefixes === null ? null : [...new Set(prefixes)].sort(),
    ...(byName ? { nameStarts: [nameStart] } : {}),
  };
}

/**
 * The loads in one file that usabl cannot follow, as `unresolvable` entries: every
 * import.meta.glob call, and every import() or require() whose path is built at run time.
 */
function loaderEntries(importer: string, calls: readonly LoaderCall[], context: LoadContext): UnresolvableImport[] {
  const entries: UnresolvableImport[] = [];
  for (const call of calls) {
    if (call.kind === 'glob') entries.push(globEntry(importer, call, context));
    if (call.kind === 'built') {
      const entry = dynamicEntry(importer, call, context);
      if (entry !== null) entries.push(entry);
    }
  }
  return entries;
}

interface BuiltGlobMatchers {
  patterns: ((file: string) => boolean)[];
  // The patterns read under every folder, each tested in one read of the path. One matches when
  // the file's path below some folder at or above it matches, the repository root included: for
  // a/b/c.tsx, that is a/b/c.tsx, b/c.tsx, or c.tsx.
  below: ((file: string) => boolean)[];
}

// The matchers of a glob entry, built the first time the entry is tested and kept with it, so a
// graph's entry builds each pattern once, not once for each file it tests. They are kept for each
// budget they charge, so a test with no budget never charges one.
const builtGlobMatchers = new WeakMap<object, Map<GlobMatchBudget | undefined, BuiltGlobMatchers>>();

function globEntryMatchers(
  entry: Extract<UnresolvableImport, { kind: 'glob-import' }>,
  patterns: readonly string[],
  budget: GlobMatchBudget | undefined,
): BuiltGlobMatchers {
  let byBudget = builtGlobMatchers.get(entry);
  if (byBudget === undefined) {
    byBudget = new Map();
    builtGlobMatchers.set(entry, byBudget);
  }
  let built = byBudget.get(budget);
  if (built === undefined) {
    const options = budget === undefined ? {} : { budget };
    built = {
      patterns: patterns.map((pattern) => globMatcher(pattern, options)),
      below: (entry.underEveryFolder ?? []).map((pattern) => globMatcher(pattern, { ...options, underEveryFolder: true })),
    };
    byBudget.set(budget, built);
  }
  return built;
}

/**
 * The characters of import.meta.glob patterns usabl matches in one run, across every call, after
 * the braces are expanded and each pattern is resolved. Each call is counted once, however many
 * graphs read it. A call that does not fit, and every call after it, may load any file. With the
 * glob matching budget, it keeps patterns written in source code from making a run slow.
 */
export class GlobImportBudget {
  remaining: number;
  // Each call read, by importer and call text, and whether it fit, so a call read again by a later
  // graph gets the same answer.
  readonly calls = new Map<string, boolean>();

  constructor(readonly characters: number) {
    this.remaining = characters;
  }

  fits(importer: string, text: string, characters: number): boolean {
    const key = `${importer}\u0000${text}`;
    const known = this.calls.get(key);
    if (known !== undefined) return known;
    const fits = this.remaining >= 0 && characters <= this.remaining;
    // Past the budget, nothing more fits.
    this.remaining = fits ? this.remaining - characters : -1;
    this.calls.set(key, fits);
    return fits;
  }
}

// The characters of import.meta.glob patterns one run reads. A normal app holds a few calls of
// under a hundred characters each.
export const GLOB_IMPORT_CHARACTERS = 65_536;

// Whether a path segment of a file starts with `start`: `tests/` names src/tests/Widget.tsx.
function pathHasSegmentStart(file: string, start: string): boolean {
  return `/${file}`.includes(`/${start}`);
}

/**
 * Whether an import usabl could not follow may load a file. A glob or a dynamic import may load
 * every file its patterns or its fixed start cover, and any file when usabl could not read them.
 * A baseUrl import may load each file it resolves to. Any other unresolved import may load a file
 * whose name its last segment names, so `@/tests/Dashboard` names `src/tests/Dashboard.tsx` (see
 * importNames). It may also load any file below a folder of that name in `packageFolders`, the
 * folders the caller found a package.json in, and each file that package.json names.
 */
export function importMayLoad(
  entry: UnresolvableImport,
  file: string,
  packageFolders: PackageFolders = new Map(),
  // Charged for the glob matching. Once it is spent, a glob may load the file, so the file is a
  // gap, never one nothing loads.
  budget?: GlobMatchBudget,
): boolean {
  if (entry.kind === 'glob-import') {
    // Each call costs one step, even for a call with no pattern to match, so a run of many such
    // calls against many files is counted too.
    if (entry.patterns === null || !chargeStep(budget, 1)) return true;
    const { patterns, below } = globEntryMatchers(entry, entry.patterns, budget);
    try {
      return patterns.some((matches) => matches(file)) || below.some((matches) => matches(file));
    } catch (err) {
      if (err instanceof GlobBudgetExhausted) return true;
      throw err;
    }
  }
  if (entry.kind === 'dynamic-import') {
    // A test costs about the length of the path for each fixed start and each name start.
    const starts = (entry.prefixes?.length ?? 0) + (entry.nameStarts?.length ?? 0);
    if (entry.prefixes !== null && !chargeStep(budget, 1 + starts * (file.length + 1))) return true;
    return (
      entry.prefixes === null ||
      entry.prefixes.some((prefix) => file.startsWith(prefix)) ||
      (entry.nameStarts ?? []).some((start) => pathHasSegmentStart(file, start))
    );
  }
  if (entry.kind === 'base-url') {
    return entry.candidates.includes(file);
  }
  if (entry.kind === 'unread-source') {
    return true;
  }
  if (entry.kind === 'package-subpath') {
    return entry.packageDir === null || file.startsWith(`${entry.packageDir}/`);
  }
  const { lastSegments, names } = namesOf(entry);
  const own = fileNamesOf(file);
  // The plain comparison: the last segment as written, with or without its extension, against the
  // file's name in its own letter case. It is kept as it is, so every file it names stays named.
  if (lastSegments.includes(own.inItsCase)) return true;
  // An import whose path names no file by name, such as '@/', may load any file.
  if (names === null) return true;
  if (own.lowered.some((name) => names.has(name))) return true;
  // An import of a folder that holds a package.json loads the file its main or exports field names:
  // any file in that folder, such as Dashboard/view.tsx for '@/tests/Dashboard', or a file outside
  // it that the field names.
  for (const [dir, folder] of packageFolders) {
    if (!names.has(path.basename(dir).toLowerCase())) continue;
    if (file.startsWith(`${dir}/`) || folder.targets === null) return true;
    if (targetsMayName(folder.targets, file)) return true;
  }
  return false;
}

// Charges the budget, if there is one. False once it is spent, which means the load may load the
// file.
function chargeStep(budget: GlobMatchBudget | undefined, steps: number): boolean {
  if (budget === undefined) return true;
  if (budget.exhausted) return false;
  try {
    budget.charge(steps);
    return true;
  } catch (err) {
    if (err instanceof GlobBudgetExhausted) return false;
    throw err;
  }
}

/**
 * Whether importMayLoad answers for a load by testing it against each file, charging the budget.
 * Every other load is answered by a LoadIndex.
 */
export function testedForEachFile(entry: UnresolvableImport): boolean {
  return (entry.kind === 'glob-import' && entry.patterns !== null) || (entry.kind === 'dynamic-import' && entry.prefixes !== null);
}

/**
 * The loads of one placement, sorted by what a file must have for each of them to load it: a name,
 * a folder above it, or nothing at all. A file is then checked against the few loads that could
 * reach it, not against every load, and each answer is the one importMayLoad gives for the pair.
 * The loads testedForEachFile names are left out: the caller asks importMayLoad for those.
 *
 * A package folder whose package.json names files costs a test for each file. That work is charged
 * to the budget, and once the budget is spent, the loads that name the folder may load the file.
 */
export class LoadIndex {
  private readonly anyFile: number[] = [];
  private readonly byLastSegment = new Map<string, number[]>();
  private readonly byName = new Map<string, number[]>();
  // Loads that may load any file below a folder: by the folder path, as the file starts with it.
  private readonly byFolder = new Map<string, number[]>();
  private readonly byFile = new Map<string, number[]>();
  private readonly folderTargets: Array<{ targets: NonNullable<PackageFolder['targets']>; loads: number[] }> = [];

  constructor(
    loads: readonly UnresolvableImport[],
    packageFolders: PackageFolders,
    private readonly budget?: GlobMatchBudget,
  ) {
    const add = (map: Map<string, number[]>, key: string, index: number): void => {
      const list = map.get(key);
      if (list === undefined) map.set(key, [index]);
      else if (list[list.length - 1] !== index) list.push(index);
    };
    loads.forEach((entry, index) => {
      if (testedForEachFile(entry)) return;
      if (entry.kind === 'glob-import' || entry.kind === 'dynamic-import' || entry.kind === 'unread-source') {
        // A glob with no patterns usabl can read, or a dynamic import with no fixed start.
        this.anyFile.push(index);
      } else if (entry.kind === 'base-url') {
        for (const candidate of entry.candidates) add(this.byFile, candidate, index);
      } else if (entry.kind === 'package-subpath') {
        if (entry.packageDir === null) this.anyFile.push(index);
        else add(this.byFolder, entry.packageDir, index);
      } else {
        const { lastSegments, names } = namesOf(entry);
        for (const segment of lastSegments) add(this.byLastSegment, segment, index);
        if (names === null) {
          this.anyFile.push(index);
          return;
        }
        for (const name of names) add(this.byName, name, index);
      }
    });
    for (const [dir, folder] of packageFolders) {
      const named = this.byName.get(path.basename(dir).toLowerCase());
      if (named === undefined) continue;
      for (const index of named) add(this.byFolder, dir, index);
      if (folder.targets === null) this.anyFile.push(...named);
      else this.folderTargets.push({ targets: folder.targets, loads: named });
    }
  }

  /** The loads that may load any file, by their place in the list the index was built from. */
  get everyFile(): readonly number[] {
    return this.anyFile;
  }

  /**
   * The other loads that may load the file, by their place in the list the index was built from,
   * sorted. With everyFile, these are every load not testedForEachFile that may load it.
   */
  matches(file: string): number[] {
    const found = new Set<number>();
    const own = fileNamesOf(file);
    for (const index of this.byLastSegment.get(own.inItsCase) ?? []) found.add(index);
    for (const name of own.lowered) for (const index of this.byName.get(name) ?? []) found.add(index);
    for (const index of this.byFile.get(file) ?? []) found.add(index);
    // Each folder the file is below, as `file.startsWith(folder + '/')` reads it.
    for (let slash = file.indexOf('/'); slash !== -1; slash = file.indexOf('/', slash + 1)) {
      for (const index of this.byFolder.get(file.slice(0, slash)) ?? []) found.add(index);
    }
    for (const { targets, loads } of this.folderTargets) {
      if (loads.every((index) => found.has(index))) continue;
      if (!chargeStep(this.budget, 1 + targets.prefixes.length) || targetsMayName(targets, file)) {
        for (const index of loads) found.add(index);
      }
    }
    return [...found].sort((a, b) => a - b);
  }
}

// What an unresolved import names, worked out once per import: placement asks about every file
// for every import, and the names do not change. Keyed by the entry, so it holds no import that is
// no longer in use.
interface ImportNamesOf {
  lastSegments: readonly string[];
  names: ReadonlySet<string> | null;
}
const NAMES_OF = new WeakMap<UnresolvableImport, ImportNamesOf>();

// The names of a file, kept for the last file asked about. Callers ask about one file for every
// import in turn, so this works each file's names out once for all of them.
interface FileNames {
  file: string;
  inItsCase: string;
  lowered: readonly string[];
}
let lastFileNames: FileNames | null = null;

function fileNamesOf(file: string): FileNames {
  if (lastFileNames?.file !== file) {
    const inItsCase = nameInItsCase(file);
    lastFileNames = { file, inItsCase, lowered: [importName(file).toLowerCase(), inItsCase.toLowerCase()] };
  }
  return lastFileNames;
}

function namesOf(entry: UnresolvableImport): ImportNamesOf {
  let found = NAMES_OF.get(entry);
  if (found === undefined) {
    const names = importNames(entry.importer, entry.specifier);
    found = { lastSegments: importLastSegments(entry.specifier), names: names === null ? null : new Set(names) };
    NAMES_OF.set(entry, found);
  }
  return found;
}

/**
 * What a folder's package.json says the folder loads: the paths its main, module, browser, and
 * exports fields name, written relative to the repository root and in lower case. `exact` holds the
 * plain paths. `prefixes` holds, for each path with a *, the part before the *, which names every
 * file whose path starts with it. `targets` is null when the file is not a JSON object, or is
 * nested deeper or holds more values than usabl reads, so the folder may load any file.
 */
export interface PackageFolder {
  targets: { exact: ReadonlySet<string>; prefixes: readonly string[] } | null;
}

/** The folders that hold a package.json, by folder path. */
export type PackageFolders = ReadonlyMap<string, PackageFolder>;

// Whether a path a package.json names may be the file: the file itself, the file without its
// extension, which the bundler adds, a folder whose index file it is, or a path with a * that
// covers it. Letter case is ignored.
function targetsMayName(targets: NonNullable<PackageFolder['targets']>, file: string): boolean {
  const lowered = file.toLowerCase();
  const stem = lowered.replace(/\.[^./]*$/u, '');
  if (targets.exact.has(lowered) || targets.exact.has(stem)) return true;
  if (path.basename(stem) === 'index' && targets.exact.has(path.dirname(lowered))) return true;
  return targets.prefixes.some((prefix) => lowered.startsWith(prefix));
}

const PACKAGE_ENTRY_FIELDS = ['main', 'module', 'browser', 'exports'];
// The deepest nesting and the most values usabl reads in those fields. Real fields are a few levels
// deep and hold a few thousand values at most. A file past either limit may load any file.
export const MAX_PACKAGE_FIELD_DEPTH = 64;
export const MAX_PACKAGE_FIELD_VALUES = 100_000;

// Every string inside the package.json fields, at any depth of an object or an array, or null when
// the fields are nested deeper than MAX_PACKAGE_FIELD_DEPTH or hold more than
// MAX_PACKAGE_FIELD_VALUES values. The walk keeps its own list of values to visit, so a deeply
// nested file cannot overflow the call stack.
function stringsIn(fields: readonly unknown[]): string[] | null {
  const found: string[] = [];
  const pending: Array<{ value: unknown; depth: number }> = fields.map((value) => ({ value, depth: 1 }));
  let visited = 0;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    visited += 1;
    if (visited > MAX_PACKAGE_FIELD_VALUES || next.depth > MAX_PACKAGE_FIELD_DEPTH) return null;
    const { value, depth } = next;
    if (typeof value === 'string') {
      found.push(value);
    } else if (typeof value === 'object' && value !== null) {
      for (const item of Array.isArray(value) ? value : Object.values(value)) pending.push({ value: item, depth: depth + 1 });
    }
  }
  return found;
}

function packageFolderOf(dir: string, text: string): PackageFolder {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { targets: null };
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return { targets: null };
  const fields = manifest as Record<string, unknown>;
  const strings = stringsIn(PACKAGE_ENTRY_FIELDS.map((field) => fields[field]));
  if (strings === null) return { targets: null };
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  for (const value of strings) {
    const target = path.normalize(path.join(dir, value)).toLowerCase();
    const star = target.indexOf('*');
    if (star === -1) exact.add(target);
    else prefixes.add(target.slice(0, star));
  }
  return { targets: { exact, prefixes: [...prefixes].sort() } };
}

/**
 * The folders above `files` that hold a package.json and whose name one of `loads` names (see
 * importNames), with what each package.json names. `known` keeps what each folder held across calls,
 * null for no package.json, so each folder is read once. Only folders a load names are read.
 */
export async function readPackageFolders(
  fs: FsGlob,
  files: readonly string[],
  loads: readonly UnresolvableImport[],
  known: Map<string, PackageFolder | null>,
): Promise<PackageFolders> {
  const wanted = new Set(loads.flatMap((entry) => (namesFilesByName(entry) ? [...(namesOf(entry).names ?? [])] : [])));
  if (wanted.size > 0) {
    const dirs = [...new Set(files.flatMap(foldersAbove))].sort();
    for (const dir of dirs) {
      if (known.has(dir) || !wanted.has(path.basename(dir).toLowerCase())) continue;
      const text = await fs.readFile(`${dir}/package.json`);
      known.set(dir, text === null ? null : packageFolderOf(dir, text));
    }
  }
  const found = new Map<string, PackageFolder>();
  for (const dir of [...known.keys()].sort()) {
    const folder = known.get(dir);
    if (folder !== null && folder !== undefined) found.set(dir, folder);
  }
  return found;
}

/**
 * Whether an import usabl could not follow may load a file by name: an import that did not resolve,
 * or a bare import no package explains. The other kinds name the files they may load by path.
 */
export function namesFilesByName(entry: UnresolvableImport): boolean {
  return !['glob-import', 'dynamic-import', 'base-url', 'package-subpath', 'unread-source'].includes(entry.kind);
}

/** Every folder that holds a file, nearest first, without the repository root. */
export function foldersAbove(file: string): string[] {
  const folders: string[] = [];
  for (let dir = path.dirname(file); dir !== '.' && dir !== '' && dir !== '/'; dir = path.dirname(dir)) folders.push(dir);
  return folders;
}

// A name without its last extension, if it has one: Dashboard for Dashboard.tsx, index for index.TSX.
function withoutExtension(name: string): string {
  return name.replace(/\.[^.]*$/u, '');
}

// The name an import would use for a file: its name without the extension, or the folder name for
// an index file, since `./Dashboard` loads `Dashboard/index.tsx`. Index.tsx and index.MDX count as
// index files too, because a disk that ignores letter case loads them for `./Dashboard`.
function importName(file: string): string {
  const segments = file.split('/');
  const stem = withoutExtension(segments[segments.length - 1] ?? '');
  if (stem.toLowerCase() === 'index' && segments.length > 1) {
    return segments[segments.length - 2] ?? stem;
  }
  return stem;
}

// The file's name in its own letter case: its name without the extension, or the folder name for a
// file named index in lower case. So Index.tsx keeps the name Index, which an import such as
// @dash/Index uses through an alias whose folder name usabl cannot see.
function nameInItsCase(file: string): string {
  const segments = file.split('/');
  const stem = withoutExtension(segments[segments.length - 1] ?? '');
  if (stem === 'index' && segments.length > 1) {
    return segments[segments.length - 2] ?? stem;
  }
  return stem;
}

// The last path segment of an import, with and without its extension, so `@/tests/Dashboard` and
// `@/tests/Dashboard.js` both name a file called Dashboard.
function importLastSegments(specifier: string): string[] {
  // A query or hash is not part of the name, so @/tests/Widget?raw names Widget.
  const last = withoutQueryOrHash(specifier).split('/').pop() ?? '';
  return [last, withoutExtension(last)];
}

// The segments that name no file: an empty one, a dot segment, and an alias or imports prefix on its
// own. An import whose path ends in one of them names a folder usabl cannot read by name.
const UNNAMED_SEGMENTS: ReadonlySet<string> = new Set(['', '.', '..', '@', '~', '#']);

// The signs an alias key or an imports key often starts with, such as @tests, ~tests, $lib, or #app.
const KEY_SIGNS = /^[@~$#]+/u;

/**
 * The names an import that did not resolve may use for a file, in lower case, or null when its path
 * names no file usabl can read by name. Each way to write the same path gives the same name. The
 * query and hash are taken off, and so are `.` and `..` segments, a trailing slash, the extension,
 * and a trailing `/index` in any letter case. So `@/tests/Dashboard`, `@/tests/Dashboard/`,
 * `@/tests/Dashboard/index`, and `@/tests/Dashboard/index.tsx` all name Dashboard. The last segment
 * as written, with and without its extension, counts too, and so does each name without a leading
 * `@`, `~`, `$`, or `#`, since an alias key such as `@tests` often names the folder `tests`. So a
 * whole imports key such as `#app` names a file called app. A relative path is read from the
 * importer's folder. One whose path ends with no name, such as the alias root `@/` or a relative path
 * to the repository root or above it, names no file by name, so it may load any file.
 */
function importNames(importer: string, specifier: string): string[] | null {
  // A query or hash is not part of the name, so @/tests/Widget?raw names Widget.
  const written = withoutQueryOrHash(specifier);
  const writtenLast = written.split('/').pop() ?? '';
  const joined = isRelativeSpecifier(written) ? path.join(path.dirname(importer), written) : path.normalize(written);
  const segments = joined.replace(/\/+$/u, '').split('/');
  const last = segments.pop() ?? '';
  const names = [writtenLast, withoutExtension(writtenLast), last, withoutExtension(last)];
  // A relative path that ends at the repository root reads as '.', and one that ends above it as '..'.
  if (withoutExtension(last).toLowerCase() === 'index' && segments.length > 0) {
    const folder = segments[segments.length - 1] ?? '';
    if (UNNAMED_SEGMENTS.has(folder)) return null;
    names.push(folder);
  } else if (UNNAMED_SEGMENTS.has(last)) {
    return null;
  }
  const lowered = names.flatMap((name) => [name, name.replace(KEY_SIGNS, '')]).map((name) => name.toLowerCase());
  return [...new Set(lowered)].filter((name) => name !== '');
}

/**
 * Whether source text names a package, or a subpath of it, as a quoted module specifier: in an
 * import or export from, a dynamic import, a require, or a bare import for its side effects, on one
 * line or across several. It matches the quoted name anywhere, so a string that only looks like an
 * import also counts. That can only over-count, which is the safe direction for a caller asking
 * whether a package is used. The single-line patterns above would miss a multi-line import.
 */
export function mentionsPackage(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(["'\`])${escaped}(?:/[^"'\`]*)?\\1`).test(source);
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('.');
}

function hasKnownExtension(specifier: string): boolean {
  return /\.[^/]+$/.test(specifier);
}

function resolveBaseFile(importer: string, specifier: string): string {
  return path.normalize(path.join(path.dirname(importer), specifier));
}

// A specifier without its query or hash, such as ./styles.css for ./styles.css?inline or
// ./styles.css#x. Vite cuts the path at the first ? or # before it looks up the path or the exports
// field, and loads the file the rest names. A # as the first character starts a package.json
// imports specifier, such as #tests/Widget, so it is kept, and a later # still ends the path.
export function withoutQueryOrHash(specifier: string): string {
  const query = specifier.indexOf('?');
  const hash = specifier.indexOf('#', 1);
  const ends = [query, hash].filter((at) => at !== -1);
  return ends.length === 0 ? specifier : specifier.slice(0, Math.min(...ends));
}

async function existingCandidates(fs: FsGlob, base: string, suffixes: string[]): Promise<string[]> {
  const hits: string[] = [];
  for (const suffix of suffixes) {
    if ((await fs.readFile(`${base}${suffix}`)) !== null) {
      hits.push(`${base}${suffix}`);
    }
  }
  return hits;
}

// What an import path resolves to: one file, several candidates usabl will not choose between,
// or nothing on disk.
type Resolution = { file: string } | { candidates: string[] } | null;

// TypeScript ESM code imports a .ts file under the name it is built to: ./Child.js loads Child.ts
// or Child.tsx. The compiler and the bundler both map these, and only when no file has the
// written name. A .d.ts file holds types only and renders nothing, so it is not a candidate.
const TYPESCRIPT_NAMES: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

async function resolveTypeScriptName(fs: FsGlob, filePath: string): Promise<Resolution> {
  const extension = path.extname(filePath);
  const replacements = TYPESCRIPT_NAMES[extension];
  if (replacements === undefined) return null;
  const hits = await existingCandidates(fs, filePath.slice(0, -extension.length), replacements);
  if (hits.length === 1 && hits[0] !== undefined) return { file: hits[0] };
  return hits.length > 1 ? { candidates: [...hits].sort() } : null;
}

async function resolveFileAtPath(fs: FsGlob, filePath: string): Promise<Resolution> {
  if (hasKnownExtension(filePath)) {
    if ((await fs.readFile(filePath)) !== null) return { file: filePath };
    const typeScriptName = await resolveTypeScriptName(fs, filePath);
    // A name such as ./Widget.spec or ./Button.styles has a dot but no module extension. When no
    // file has that exact name, the bundler and the compiler add an extension, as they do for a
    // name with no dot, so the suffixes below are tried too.
    const extension = path.extname(filePath);
    if (typeScriptName !== null || EXTENSIONS.includes(extension) || extension in TYPESCRIPT_NAMES) {
      return typeScriptName;
    }
  }
  // File tier before index tier (the bundler prefers a file over a directory index). Within a tier,
  // exactly one hit resolves; more than one is ambiguous, so disclose rather than pick.
  for (const suffixes of [FILE_SUFFIXES, INDEX_SUFFIXES]) {
    const hits = await existingCandidates(fs, filePath, suffixes);
    if (hits.length === 1 && hits[0] !== undefined) {
      return { file: hits[0] };
    }
    if (hits.length > 1) {
      return { candidates: [...hits].sort() };
    }
  }
  return null;
}

async function resolveRelativeImport(fs: FsGlob, importer: string, specifier: string): Promise<Resolution> {
  const base = resolveBaseFile(importer, withoutQueryOrHash(specifier));
  return resolveFileAtPath(fs, base);
}

// The files an import links to. An ambiguous import links every candidate: a change to any of them
// then maps to the screen, which can scan a screen that does not render the changed file, but
// never leaves out one that does. The ambiguity is still disclosed.
function edgeTargets(resolution: Resolution): string[] {
  if (resolution === null) return [];
  return 'file' in resolution ? [resolution.file] : resolution.candidates;
}

// The disclosure for an import that did not resolve to exactly one file.
function unresolvedEntry(
  importer: string,
  specifier: string,
  resolution: { candidates: string[] } | null,
): UnresolvableImport {
  return resolution === null
    ? { importer, specifier, kind: 'file-not-found' }
    : { importer, specifier, kind: 'ambiguous-candidates', candidates: resolution.candidates };
}

// The files an alias import links to, and its disclosure when it did not resolve to exactly one
// file. An import the configs map to more than one place resolves at each, and links every file
// found there: dropping any of them could leave out a screen that renders the changed file.
async function resolveAliasImport(
  fs: FsGlob,
  importer: string,
  specifier: string,
  aliasConfig: AliasConfig,
): Promise<{ targets: string[]; disclosure: UnresolvableImport | null }> {
  // The file lookup uses the path without its query or hash. The disclosure keeps the import as
  // written.
  const aliasPaths = resolveAliasSpecifierEachWay(withoutQueryOrHash(specifier), aliasConfig);
  if (aliasPaths.length === 0) {
    const kind = aliasConfig.hasAliasConfig ? 'alias-unmapped' : 'alias-unconfigured';
    return { targets: [], disclosure: { importer, specifier, kind } };
  }
  if (aliasPaths.length === 1 && aliasPaths[0] !== undefined) {
    const resolved = await resolveFileAtPath(fs, aliasPaths[0]);
    const disclosure = resolved === null || 'candidates' in resolved ? unresolvedEntry(importer, specifier, resolved) : null;
    return { targets: edgeTargets(resolved), disclosure };
  }
  const found = new Set<string>();
  for (const aliasPath of aliasPaths) {
    for (const target of edgeTargets(await resolveFileAtPath(fs, aliasPath))) found.add(target);
  }
  const candidates = [...found].sort();
  if (candidates.length === 0) {
    return { targets: [], disclosure: { importer, specifier, kind: 'file-not-found' } };
  }
  return { targets: candidates, disclosure: { importer, specifier, kind: 'alias-conflict', targets: aliasPaths, candidates } };
}

// The keys of the entries in each list, so a list with many entries is not searched for each new
// one. Only pushUniqueUnresolvable adds to a list it keys.
const UNRESOLVABLE_KEYS = new WeakMap<UnresolvableImport[], Set<string>>();

function pushUniqueUnresolvable(list: UnresolvableImport[], entry: UnresolvableImport): void {
  const keyOf = (item: UnresolvableImport): string => `${item.importer}:${item.specifier}:${item.kind}`;
  let keys = UNRESOLVABLE_KEYS.get(list);
  if (keys === undefined) {
    keys = new Set(list.map(keyOf));
    UNRESOLVABLE_KEYS.set(list, keys);
  }
  const key = keyOf(entry);
  if (!keys.has(key)) {
    keys.add(key);
    list.push(entry);
  }
}

// A reader that reads each path once. One graph probes the same candidate paths from many files,
// and the tree does not change while it is built.
function readOnce(fs: FsGlob): FsGlob {
  const cache = new Map<string, Promise<string | null>>();
  return {
    readFile: (file) => {
      let read = cache.get(file);
      if (read === undefined) {
        read = fs.readFile(file);
        cache.set(file, read);
      }
      return read;
    },
    glob: (patterns) => fs.glob(patterns),
    ...(fs.globUnder === undefined ? {} : { globUnder: fs.globUnder.bind(fs) }),
  };
}

// The workspace package a bare import names a path inside of, and that path, or null when it names
// no workspace package or only the package itself.
function workspaceSubpath(
  specifier: string,
  packages: readonly WorkspacePackageView[],
): { dir: string; subpath: string; hasExports: boolean; exportTarget: string | null; exportLeaves: boolean } | null {
  // A query or hash is not part of the subpath, for the exports lookup and for the path lookup alike.
  const bare = withoutQueryOrHash(specifier);
  const name = packageNameOf(bare);
  const owner = packages.find((candidate) => candidate.name === name);
  if (owner === undefined || bare.length <= name.length + 1) return null;
  const subpath = bare.slice(name.length + 1);
  // The exports entry whose key is this subpath exactly, as Node.js picks it before any pattern key.
  const key = `./${subpath}`;
  const exact = owner.exactExports ?? {};
  const exportTarget = owner.hasExports && Object.hasOwn(exact, key) ? (exact[key] ?? null) : null;
  const leaving = owner.leavingExportKeys ?? [];
  const exportLeaves = owner.hasExports && matchedExportKeys(owner.exportKeys ?? [], key).some((matched) => leaving.includes(matched));
  return { dir: owner.dir, subpath, hasExports: owner.hasExports, exportTarget, exportLeaves };
}

// The files a bare import resolves to under each baseUrl folder, sorted. Empty when none does,
// which means the import names a package.
async function baseUrlCandidates(fs: FsGlob, specifier: string, baseUrlDirs: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const dir of baseUrlDirs) {
    const base = path.normalize(path.join(dir, withoutQueryOrHash(specifier)));
    if (base === '..' || base.startsWith('../')) continue;
    for (const target of edgeTargets(await resolveFileAtPath(fs, base))) found.add(target);
  }
  return [...found].sort();
}

/**
 * The most text the import reader reads in one file, and on one line of it, in UTF-16 code units.
 * The reader's time grows with the length of the text, and honest source files and lines are far
 * shorter. A file past either bound is not read for imports: it is an `unread-source` entry that
 * may load any file, never a file with no imports.
 */
export const MAX_SOURCE_CHARACTERS = 4_194_304;
export const MAX_SOURCE_LINE_CHARACTERS = 1_048_576;

function unreadSource(file: string, source: string): UnresolvableImport | null {
  if (source.length > MAX_SOURCE_CHARACTERS) {
    return { importer: file, specifier: '', kind: 'unread-source', why: 'size' };
  }
  let start = 0;
  while (start <= source.length) {
    const end = source.indexOf('\n', start);
    const lineEnd = end === -1 ? source.length : end;
    if (lineEnd - start > MAX_SOURCE_LINE_CHARACTERS) {
      return { importer: file, specifier: '', kind: 'unread-source', why: 'line' };
    }
    if (end === -1) break;
    start = end + 1;
  }
  return null;
}

export async function buildImportGraph(
  rawFs: FsGlob,
  entryFiles: string[],
  aliasConfig?: AliasConfig,
  options: ImportGraphOptions = {},
): Promise<ImportGraphView> {
  const fs = readOnce(rawFs);
  const complete = options.complete === true;
  const baseUrlDirs = complete ? (options.baseUrlDirs ?? []) : [];
  const edges = new Map<string, string[]>();
  const visited = new Set<string>();
  const queue = [...entryFiles];
  const unresolvable: UnresolvableImport[] = [];
  const aliases = aliasConfig ?? NO_ALIASES;
  const packages = complete && options.declaredPackages !== undefined ? new Set(options.declaredPackages) : null;
  const workspacePackages = complete ? (options.workspacePackages ?? []) : [];
  const context: LoadContext = { aliases, baseUrlDirs, packages, rootedUnderEveryFolder: complete, globImports: options.globImports };

  while (queue.length > 0) {
    const file = queue.shift();
    if (typeof file !== 'string' || visited.has(file)) {
      continue;
    }
    visited.add(file);

    const source = await fs.readFile(file);
    if (source === null) {
      continue;
    }

    const fileEdges = edges.get(file) ?? [];
    const unread = unreadSource(file, source);
    if (unread !== null) {
      pushUniqueUnresolvable(unresolvable, unread);
      edges.set(file, fileEdges);
      continue;
    }
    const calls = findLoaderCallsInCode(source, file);
    for (const entry of loaderEntries(file, calls, context)) pushUniqueUnresolvable(unresolvable, entry);
    for (const specifier of complete ? extractEverySpecifier(source, calls) : extractSpecifiers(source)) {
      // The complete reading also follows a bare import that a configured alias maps, whatever its
      // prefix, as the bundler does.
      if (
        isAliasLikeSpecifier(specifier) ||
        (complete && !isRelativeSpecifier(specifier) && resolveAliasSpecifierEachWay(withoutQueryOrHash(specifier), aliases).length > 0)
      ) {
        const { targets, disclosure } = await resolveAliasImport(fs, file, specifier, aliases);
        if (disclosure !== null) pushUniqueUnresolvable(unresolvable, disclosure);
        for (const target of targets) {
          pushUnique(fileEdges, target);
          queue.push(target);
        }
        continue;
      }

      const inPackage = isRelativeSpecifier(specifier) ? null : workspaceSubpath(specifier, workspacePackages);
      if (inPackage !== null) {
        // A path inside a workspace package is followed to the file it names under the package
        // folder, as a hoisted install resolves it, when the package has no exports field. With
        // one, the resolver reads it in place of the folders, and a path that names no file there
        // may go through it too, so either may load any file of the package.
        // A path that leaves the package folder is not narrowed to it, so it may load any file.
        // An exports entry with a target that leaves the package folder may lead a bundler into
        // another package, so the import may load any file.
        if (inPackage.exportLeaves) {
          pushUniqueUnresolvable(unresolvable, { importer: file, specifier, kind: 'package-subpath', packageDir: null });
          continue;
        }
        // An exports entry usabl reads exactly is followed to the one file it names, when that file
        // is inside the package folder.
        if (inPackage.exportTarget !== null) {
          const exported = path.normalize(path.join(inPackage.dir, inPackage.exportTarget));
          if (exported.startsWith(`${inPackage.dir}/`) && (await fs.readFile(exported)) !== null) {
            pushUnique(fileEdges, exported);
            queue.push(exported);
            continue;
          }
        }
        const target = path.normalize(path.join(inPackage.dir, inPackage.subpath));
        const inside = target.startsWith(`${inPackage.dir}/`);
        const resolved = inside && !inPackage.hasExports ? await resolveFileAtPath(fs, target) : null;
        if (resolved === null) {
          pushUniqueUnresolvable(unresolvable, { importer: file, specifier, kind: 'package-subpath', packageDir: inside ? inPackage.dir : null });
          continue;
        }
        if ('candidates' in resolved) pushUniqueUnresolvable(unresolvable, unresolvedEntry(file, specifier, resolved));
        for (const found of edgeTargets(resolved)) {
          pushUnique(fileEdges, found);
          queue.push(found);
        }
        continue;
      }

      if (!isRelativeSpecifier(specifier)) {
        // A bare import names a package, which is not an app file, so it is ignored. The complete
        // reading records one that a baseUrl resolves to a file in the repository, and one that no
        // package explains.
        const candidates = baseUrlDirs.length > 0 ? await baseUrlCandidates(fs, specifier, baseUrlDirs) : [];
        if (candidates.length > 0) {
          pushUniqueUnresolvable(unresolvable, { importer: file, specifier, kind: 'base-url', candidates });
        } else if (unexplainedBare(specifier, packages)) {
          pushUniqueUnresolvable(unresolvable, { importer: file, specifier, kind: 'bare-unknown' });
        }
        continue;
      }

      const resolved = await resolveRelativeImport(fs, file, specifier);
      if (resolved === null || 'candidates' in resolved) {
        pushUniqueUnresolvable(unresolvable, unresolvedEntry(file, specifier, resolved));
      }
      for (const target of edgeTargets(resolved)) {
        pushUnique(fileEdges, target);
        queue.push(target);
      }
    }
    edges.set(file, fileEdges);
  }

  return {
    get(file: string): string[] {
      return edges.get(file) ?? [];
    },
    unresolvable,
    visited,
  };
}

// The values in each edge list, for the same reason as UNRESOLVABLE_KEYS.
const EDGE_VALUES = new WeakMap<string[], Set<string>>();

function pushUnique(list: string[], value: string): void {
  let values = EDGE_VALUES.get(list);
  if (values === undefined) {
    values = new Set(list);
    EDGE_VALUES.set(list, values);
  }
  if (!values.has(value)) {
    values.add(value);
    list.push(value);
  }
}

export async function inspectDirectImports(
  fs: FsGlob,
  file: string,
  aliasConfig?: AliasConfig,
): Promise<UnresolvableImport[]> {
  const source = await fs.readFile(file);
  if (source === null) {
    return [];
  }
  const unread = unreadSource(file, source);
  if (unread !== null) {
    return [unread];
  }
  const aliases = aliasConfig ?? NO_ALIASES;
  const unresolvable: UnresolvableImport[] = [];
  for (const entry of loaderEntries(file, findLoaderCallsInCode(source, file), {
    aliases,
    baseUrlDirs: [],
    packages: null,
    rootedUnderEveryFolder: false,
    globImports: undefined,
  })) {
    pushUniqueUnresolvable(unresolvable, entry);
  }

  for (const specifier of extractSpecifiers(source)) {
    if (isAliasLikeSpecifier(specifier)) {
      const { disclosure } = await resolveAliasImport(fs, file, specifier, aliases);
      if (disclosure !== null) pushUniqueUnresolvable(unresolvable, disclosure);
      continue;
    }
    if (isRelativeSpecifier(specifier)) {
      const resolved = await resolveRelativeImport(fs, file, specifier);
      if (resolved === null || 'candidates' in resolved) {
        pushUniqueUnresolvable(unresolvable, unresolvedEntry(file, specifier, resolved));
      }
    }
  }
  return unresolvable;
}
