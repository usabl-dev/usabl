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
import { braceRangeIn, expandBraces, matchGlob, UNSUPPORTED_GLOB_CHARACTERS } from '../primitives/match-glob.js';
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
      // Why the patterns are null: the argument is not a string or a list of strings, the
      // options set `base`, a pattern starts in a way usabl cannot resolve, or a pattern has a
      // part usabl cannot read exactly (see braceAlternatives). Absent otherwise.
      unread?: 'argument' | 'base' | 'start' | 'pattern';
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
  // The Vite root (see viteRootFor), '' for the repository root. A glob pattern that starts with /
  // is read from it, as Vite reads it. Null when usabl cannot know it, so such a pattern may load
  // any file. Read only when complete.
  viteRoot?: string | null;
  // The workspace packages, by name and folder, and whether each has an exports field. A bare
  // import of a path inside one, such as '@acme/ui/src/tests/helpers', is followed to the file it
  // names under the package folder when the package has no exports field. It is recorded as
  // `package-subpath` when it names no file, or when the package has an exports field, which the
  // resolver reads in place of the folder layout. Read only when complete.
  workspacePackages?: readonly { name: string; dir: string; hasExports: boolean }[];
}

export interface ImportGraphView {
  get(file: string): string[];
  unresolvable: UnresolvableImport[];
  visited: ReadonlySet<string>;
}

// This pattern stays single-line by design. A multiline static import can be missed,
// which under-reports edges. Under-reporting is safer here because discovery must
// never invent import edges that were not proven by concrete source text and files.
const FROM_IMPORT_RE = /\bimport\s+(?:type\s+)?[^"'`;\n]+?\sfrom\s*["'`]([^"'`]+)["'`]/g;
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
  for (const match of source.matchAll(FROM_IMPORT_RE)) {
    const [, specifier] = match;
    if (typeof specifier === 'string') {
      found.push(specifier);
    }
  }
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

// Skips spaces, line breaks, and comments. A comment inside a call, such as a webpack chunk name,
// is common and is not part of the path.
function skipBlank(source: string, from: number): number {
  let index = from;
  for (;;) {
    while (index < source.length && /\s/u.test(source.charAt(index))) index += 1;
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      if (close === -1) return source.length;
      index = close + 2;
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index);
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
  // `base` is set when the patterns are null because the options set base.
  | { kind: 'glob'; text: string; patterns: string[] | null; base?: true };

// The first argument of the import() or require() whose opening parenthesis is at `open`.
function readDynamicCall(source: string, start: number, open: number): LoaderCall {
  const text = callText(source, start);
  const at = skipBlank(source, open + 1);
  const quoted = readQuoted(source, at);
  if (quoted === null) return { kind: 'built', text, prefix: null };
  if (quoted.interpolated) return { kind: 'built', text, prefix: quoted.text };
  const after = source.charAt(skipBlank(source, quoted.end));
  // A string followed by anything other than the end of the argument, such as + name, is a path
  // built at run time. Only its fixed start would be known, and usabl does not read past a string.
  if (after === ')' || after === ',') return { kind: 'literal', path: quoted.text };
  return { kind: 'built', text, prefix: null };
}

// The patterns of the import.meta.glob call that starts at `start`: one string or a list of
// strings. Null when the argument is anything else, or when an options object sets `base`, which
// moves where relative patterns start.
function readGlobCall(source: string, start: number, nameEnd: number): LoaderCall {
  const text = callText(source, start);
  let at = skipBlank(source, nameEnd);
  // A type argument, such as import.meta.glob<Module>('./x/*.ts').
  if (source.charAt(at) === '<') {
    const close = source.indexOf('>', at);
    if (close === -1) return { kind: 'glob', text, patterns: null };
    at = skipBlank(source, close + 1);
  }
  if (source.charAt(at) !== '(') return { kind: 'glob', text, patterns: null };
  at = skipBlank(source, at + 1);
  const patterns: string[] = [];
  const readOne = (from: number): number | null => {
    const quoted = readQuoted(source, from);
    if (quoted === null || quoted.interpolated) return null;
    patterns.push(quoted.text);
    return skipBlank(source, quoted.end);
  };
  if (source.charAt(at) === '[') {
    at = skipBlank(source, at + 1);
    for (;;) {
      if (source.charAt(at) === ']') break;
      const next = readOne(at);
      if (next === null) return { kind: 'glob', text, patterns: null };
      if (source.charAt(next) === ',') {
        at = skipBlank(source, next + 1);
        continue;
      }
      if (source.charAt(next) !== ']') return { kind: 'glob', text, patterns: null };
      at = next;
      break;
    }
    at = skipBlank(source, at + 1);
  } else {
    const next = readOne(at);
    if (next === null) return { kind: 'glob', text, patterns: null };
    at = next;
  }
  if (source.charAt(at) === ')') return { kind: 'glob', text, patterns };
  if (source.charAt(at) !== ',') return { kind: 'glob', text, patterns: null };
  const close = source.indexOf(')', at);
  const options = source.slice(at, close === -1 ? source.length : close);
  return /\bbase\s*:/u.test(options) ? { kind: 'glob', text, patterns: null, base: true } : { kind: 'glob', text, patterns };
}

// A webpack require.context(folder, recursive, pattern) call. It loads files under the folder, so
// the folder is the fixed start of what it may load. Its other arguments only narrow that set, so
// they are not read. A first argument that is not a string may point anywhere.
function readContextCall(source: string, start: number, open: number): LoaderCall {
  const text = callText(source, start);
  const quoted = readQuoted(source, skipBlank(source, open + 1));
  if (quoted === null || quoted.interpolated) return { kind: 'built', text, prefix: quoted === null ? null : quoted.text };
  const after = source.charAt(skipBlank(source, quoted.end));
  if (after !== ')' && after !== ',') return { kind: 'built', text, prefix: null };
  return { kind: 'built', text, prefix: quoted.text.endsWith('/') ? quoted.text : `${quoted.text}/` };
}

const CONTEXT_CALL_RE = /(?<![\w$.])require\s*\.\s*context\s*\(/g;

// A call and the offset where it starts.
type FoundCall = LoaderCall & { at: number };

function findLoaderCalls(source: string): FoundCall[] {
  const calls: FoundCall[] = [];
  for (const match of source.matchAll(GLOB_CALL_RE)) {
    calls.push({ ...readGlobCall(source, match.index, match.index + match[0].length), at: match.index });
  }
  for (const match of source.matchAll(DYNAMIC_CALL_RE)) {
    calls.push({ ...readDynamicCall(source, match.index, match.index + match[0].length - 1), at: match.index });
  }
  for (const match of source.matchAll(CONTEXT_CALL_RE)) {
    calls.push({ ...readContextCall(source, match.index, match.index + match[0].length - 1), at: match.index });
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
  return calls.filter((call) => !comments.some((comment) => call.at >= comment.start && call.at < comment.end));
}

// What the graph knows when it reads a load: the aliases, the baseUrl folders, and, in the
// complete reading, the package names a bare import may name. `packages` is null in the default
// reading, where every bare name is read as a package, as it always was.
interface LoadContext {
  aliases: AliasConfig;
  baseUrlDirs: readonly string[];
  packages: ReadonlySet<string> | null;
  // The folder a glob pattern that starts with / is read from, '' for the repository root. Null
  // when not known, so such a pattern may load any file.
  viteRoot: string | null;
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
function unexplainedBare(specifier: string, packages: ReadonlySet<string> | null): boolean {
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

function globEntry(importer: string, call: Extract<LoaderCall, { kind: 'glob' }>, context: LoadContext): UnresolvableImport {
  const { aliases, baseUrlDirs, viteRoot } = context;
  const open = (unread: 'argument' | 'base' | 'start' | 'pattern'): UnresolvableImport => ({
    importer,
    specifier: call.text,
    kind: 'glob-import',
    patterns: null,
    unread,
  });
  if (call.patterns === null) return open(call.base === true ? 'base' : 'argument');
  const resolved: string[] = [];
  const widened: string[] = [];
  // A negative pattern only takes files away, so leaving it out can only name more files.
  for (const pattern of call.patterns.filter((candidate) => !candidate.startsWith('!'))) {
    // The braces are expanded first, so a .. or an alias inside an alternative is resolved.
    const alternatives = braceAlternatives(pattern);
    if (alternatives === null) return open('pattern');
    for (const alternative of alternatives) {
      // Vite reads a pattern that starts with / from its root.
      const paths =
        alternative.startsWith('/') && viteRoot !== null
          ? [path.normalize(path.join(viteRoot === '' ? '.' : viteRoot, alternative.slice(1)))]
          : resolveLoaderPaths(importer, alternative, aliases, baseUrlDirs, 'glob');
      if (paths === null) return open('start');
      for (const resolvedPath of paths) {
        if (readableGlob(resolvedPath)) {
          resolved.push(resolvedPath);
        } else {
          resolved.push(folderAbove(resolvedPath));
          widened.push(pattern);
        }
      }
    }
  }
  return {
    importer,
    specifier: call.text,
    kind: 'glob-import',
    patterns: [...new Set(resolved)].sort(),
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
  const prefixes = resolveLoaderPaths(importer, call.prefix, aliases, baseUrlDirs, 'prefix');
  const nameStart = call.prefix.replace(/^#/u, '');
  const byName = prefixes !== null && isBareStart(call.prefix, aliases) && !startNamesKnownPackage(call.prefix, packages);
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

// Whether a path segment of a file starts with `start`: `tests/` names src/tests/Widget.tsx.
function pathHasSegmentStart(file: string, start: string): boolean {
  return `/${file}`.includes(`/${start}`);
}

/**
 * Whether an import usabl could not follow may load a file. A glob or a dynamic import may load
 * every file its patterns or its fixed start cover, and any file when usabl could not read them.
 * A baseUrl import may load each file it resolves to. Any other unresolved import may load a file
 * whose name its last segment names, so `@/tests/Dashboard` names `src/tests/Dashboard.tsx`.
 */
export function importMayLoad(entry: UnresolvableImport, file: string): boolean {
  if (entry.kind === 'glob-import') {
    return entry.patterns === null || entry.patterns.some((pattern) => matchGlob(pattern, file));
  }
  if (entry.kind === 'dynamic-import') {
    return (
      entry.prefixes === null ||
      entry.prefixes.some((prefix) => file.startsWith(prefix)) ||
      (entry.nameStarts ?? []).some((start) => pathHasSegmentStart(file, start))
    );
  }
  if (entry.kind === 'base-url') {
    return entry.candidates.includes(file);
  }
  if (entry.kind === 'package-subpath') {
    return entry.packageDir === null || file.startsWith(`${entry.packageDir}/`);
  }
  return importLastSegments(entry.specifier).includes(importName(file));
}

// The name an import would use for a file: its name without the extension, or the folder name for
// an index file, since `./Dashboard` loads `Dashboard/index.tsx`.
function importName(file: string): string {
  const segments = file.split('/');
  const base = segments[segments.length - 1] ?? '';
  const stem = base.replace(/\.[^.]*$/u, '');
  if (stem === 'index' && segments.length > 1) {
    return segments[segments.length - 2] ?? stem;
  }
  return stem;
}

// The last path segment of an import, with and without its extension, so `@/tests/Dashboard` and
// `@/tests/Dashboard.js` both name a file called Dashboard.
function importLastSegments(specifier: string): string[] {
  const last = specifier.split('/').pop() ?? '';
  return [last, last.replace(/\.[^.]*$/u, '')];
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
  const base = resolveBaseFile(importer, specifier);
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
  const aliasPaths = resolveAliasSpecifierEachWay(specifier, aliasConfig);
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

function pushUniqueUnresolvable(list: UnresolvableImport[], entry: UnresolvableImport): void {
  const key = `${entry.importer}:${entry.specifier}:${entry.kind}`;
  if (!list.some((item) => `${item.importer}:${item.specifier}:${item.kind}` === key)) {
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
  };
}

// The workspace package a bare import names a path inside of, and that path, or null when it names
// no workspace package or only the package itself.
function workspaceSubpath(
  specifier: string,
  packages: readonly { name: string; dir: string; hasExports: boolean }[],
): { dir: string; subpath: string; hasExports: boolean } | null {
  const name = packageNameOf(specifier);
  const owner = packages.find((candidate) => candidate.name === name);
  if (owner === undefined || specifier.length <= name.length + 1) return null;
  return { dir: owner.dir, subpath: specifier.slice(name.length + 1), hasExports: owner.hasExports };
}

// The files a bare import resolves to under each baseUrl folder, sorted. Empty when none does,
// which means the import names a package.
async function baseUrlCandidates(fs: FsGlob, specifier: string, baseUrlDirs: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const dir of baseUrlDirs) {
    const base = path.normalize(path.join(dir, specifier));
    if (base === '..' || base.startsWith('../')) continue;
    for (const target of edgeTargets(await resolveFileAtPath(fs, base))) found.add(target);
  }
  return [...found].sort();
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
  const viteRoot = complete ? (options.viteRoot ?? null) : null;
  const workspacePackages = complete ? (options.workspacePackages ?? []) : [];
  const context: LoadContext = { aliases, baseUrlDirs, packages, viteRoot };

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
    const calls = findLoaderCallsInCode(source, file);
    for (const entry of loaderEntries(file, calls, context)) pushUniqueUnresolvable(unresolvable, entry);
    for (const specifier of complete ? extractEverySpecifier(source, calls) : extractSpecifiers(source)) {
      // The complete reading also follows a bare import that a configured alias maps, whatever its
      // prefix, as the bundler does.
      if (isAliasLikeSpecifier(specifier) || (complete && !isRelativeSpecifier(specifier) && resolveAliasSpecifierEachWay(specifier, aliases).length > 0)) {
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

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
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
  const aliases = aliasConfig ?? NO_ALIASES;
  const unresolvable: UnresolvableImport[] = [];
  for (const entry of loaderEntries(file, findLoaderCallsInCode(source, file), { aliases, baseUrlDirs: [], packages: null, viteRoot: null })) {
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
