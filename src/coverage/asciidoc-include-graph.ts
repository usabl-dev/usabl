/**
 * AsciiDoc include-closure discovery for docs coverage planning.
 * This is the docs analog of src/coverage/import-graph.ts: given a root .adoc file
 * (a guide master or an assembly), it follows real `include::` transclusions to the
 * full set of source files that compose the page, which becomes pages[].sources.
 *
 * Invariants that keep coverage honest:
 * - Over-approximate, never under-map. Conditional includes (ifdef/ifndef/ifeval) are
 *   NOT evaluated; their targets are followed so a changed file is never dropped.
 * - Only real transclusions are followed. Includes shown as code (inside ----, ....,
 *   ++++ blocks) or commented out (// line, //// block) are ignored.
 * - Every resolved path is normalized and containment-checked against the base root,
 *   mirroring expectSafeRelativePath in docs-manifest.ts. A target that escapes the
 *   base root is recorded as unresolved and is never read or followed.
 * - The root file is always among the sources, so a page's assemblyFile is guaranteed
 *   to appear in its sources. Output paths are repo-relative and normalized exactly as
 *   git status reports them (no leading "./", forward slashes), so docs-planner's
 *   exact-string sources.includes(file) match holds.
 */
// POSIX paths keep coverage keys stable across operating systems and match git output.
import { posix as path } from 'node:path';
import type { FsGlob } from '../contracts/index.js';

export interface AdocIncludeGraph {
  // Repo-relative, normalized, de-duplicated, sorted source files composing the page.
  sources: string[];
  // Includes that could not be followed. Never a crash: unresolved is recorded evidence.
  unresolved: Array<{ from: string; target: string; reason: string }>;
}

// Reasons are stable strings so consumers and tests can match on intent, not phrasing.
const REASON_UNRESOLVED_ATTR = 'unresolved attribute reference in include target';
const REASON_NOT_FOUND = 'include target not found';
const REASON_ESCAPES_ROOT = 'include target escapes the base root';

interface AttrDef {
  name: string;
  value: string | null; // null means the entry unsets the attribute
}

interface ParsedAdoc {
  attrDefs: AttrDef[];
  includes: string[]; // raw include targets, in reading order
}

interface IncludeRecord {
  from: string; // repo-relative file that contains the include directive
  rawTarget: string; // the target exactly as written, before attribute substitution
  done: boolean;
}

// A block delimiter line is 4+ of a single delimiter character and nothing else.
function isDelimiterLine(trimmed: string, char: string): boolean {
  if (trimmed.length < 4) {
    return false;
  }
  for (const c of trimmed) {
    if (c !== char) {
      return false;
    }
  }
  return true;
}

// Listing (----), literal (....), and passthrough (++++) blocks are verbatim: includes
// inside them are code samples, not transclusions. Example/sidebar/quote blocks are NOT
// verbatim, so they are intentionally absent here.
function verbatimDelimiterOf(trimmed: string): string | null {
  for (const char of ['-', '.', '+']) {
    if (isDelimiterLine(trimmed, char)) {
      return char;
    }
  }
  return null;
}

function matchAttributeDef(trimmed: string): AttrDef | null {
  // Unset forms come first so they are not mistaken for a set with an empty value.
  const unsetLeading = /^:!([A-Za-z0-9_][A-Za-z0-9_-]*):$/.exec(trimmed);
  if (unsetLeading) {
    return { name: unsetLeading[1] as string, value: null };
  }
  const unsetTrailing = /^:([A-Za-z0-9_][A-Za-z0-9_-]*)!:$/.exec(trimmed);
  if (unsetTrailing) {
    return { name: unsetTrailing[1] as string, value: null };
  }
  // `:name:` sets an empty value; `:name: value` requires whitespace before the value.
  const set = /^:([A-Za-z0-9_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(trimmed);
  if (set) {
    return { name: set[1] as string, value: (set[2] ?? '').trim() };
  }
  return null;
}

// A valid include is its own line: include::TARGET[OPTS]. OPTS (leveloffset, tags,
// lines) are ignored for path purposes. Without brackets it is not a directive.
function matchIncludeTarget(trimmed: string): string | null {
  const match = /^include::([^[]+)\[[^\]]*\]\s*$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return (match[1] as string).trim();
}

function parseAdoc(content: string): ParsedAdoc {
  const attrDefs: AttrDef[] = [];
  const includes: string[] = [];
  let inCommentBlock = false;
  let openVerbatim: string | null = null;

  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();

    if (inCommentBlock) {
      if (isDelimiterLine(trimmed, '/')) {
        inCommentBlock = false;
      }
      continue;
    }
    if (openVerbatim !== null) {
      if (isDelimiterLine(trimmed, openVerbatim)) {
        openVerbatim = null;
      }
      continue;
    }

    if (isDelimiterLine(trimmed, '/')) {
      inCommentBlock = true;
      continue;
    }
    const verbatim = verbatimDelimiterOf(trimmed);
    if (verbatim !== null) {
      openVerbatim = verbatim;
      continue;
    }
    if (trimmed.startsWith('//')) {
      // Line comment (not a //// delimiter, which was handled above).
      continue;
    }

    const attr = matchAttributeDef(trimmed);
    if (attr) {
      attrDefs.push(attr);
      continue;
    }
    const target = matchIncludeTarget(trimmed);
    if (target !== null) {
      includes.push(target);
    }
  }

  return { attrDefs, includes };
}

function applyAttribute(attributes: Map<string, string>, def: AttrDef): void {
  if (def.value === null) {
    attributes.delete(def.name);
  } else {
    attributes.set(def.name, def.value);
  }
}

// Substitute {name} references using known attributes. Returns null when at least one
// reference cannot be resolved yet, so the caller can defer it until more files are read.
function substituteAttributes(target: string, attributes: Map<string, string>): string | null {
  const REFERENCE = /\{([A-Za-z0-9_][A-Za-z0-9_-]*)\}/;
  let current = target;
  // Bounded to stop on cyclic attribute definitions instead of looping forever.
  for (let pass = 0; pass < 16; pass++) {
    if (!REFERENCE.test(current)) {
      return current;
    }
    let unresolved = false;
    current = current.replace(new RegExp(REFERENCE, 'g'), (whole, name: string) => {
      const value = attributes.get(name);
      if (value === undefined) {
        unresolved = true;
        return whole;
      }
      return value;
    });
    if (unresolved) {
      return null;
    }
  }
  return null;
}

function normalizeRepoPath(p: string): string {
  // posix.normalize collapses "./" and ".." segments and yields forward slashes, which
  // is exactly how git reports working-tree paths.
  return path.normalize(p);
}

// Containment mirrors expectSafeRelativePath in docs-manifest.ts: the resolved path must
// stay under the base root. Absolute paths and any ".." escape are rejected.
function isContainedIn(baseRoot: string, candidate: string): boolean {
  if (path.isAbsolute(candidate)) {
    return false;
  }
  const base = path.normalize(baseRoot === '' ? '.' : baseRoot);
  const relative = path.relative(base, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Resolve TARGET relative to the including file's directory, then containment-check.
// Returns null when the target escapes the base root (never read or followed).
function resolveIncludePath(baseRoot: string, includer: string, target: string): string | null {
  const resolved = normalizeRepoPath(path.join(path.dirname(includer), target));
  return isContainedIn(baseRoot, resolved) ? resolved : null;
}

export async function buildAdocIncludeGraph(
  fs: Pick<FsGlob, 'readFile'>,
  rootFile: string,
  baseRoot = '.',
): Promise<AdocIncludeGraph> {
  const normalizedRoot = normalizeRepoPath(rootFile);
  const attributes = new Map<string, string>();
  // The root is always a source, so a page's assemblyFile is guaranteed to appear.
  const sources = new Set<string>([normalizedRoot]);
  const contentByFile = new Map<string, string | null>();
  const includeRecords: IncludeRecord[] = [];
  const unresolved = new Map<string, { from: string; target: string; reason: string }>();

  const recordUnresolved = (from: string, target: string, reason: string): void => {
    const key = `${from} ${target}`;
    if (!unresolved.has(key)) {
      unresolved.set(key, { from, target, reason });
    }
  };

  const readAndIngest = async (file: string): Promise<string | null> => {
    if (contentByFile.has(file)) {
      return contentByFile.get(file) ?? null;
    }
    const content = await fs.readFile(file);
    contentByFile.set(file, content);
    if (content === null) {
      return null;
    }
    const parsed = parseAdoc(content);
    // Apply every attribute the file defines before its includes are resolved, so an
    // attribute defined below its use in the same file still resolves.
    for (const def of parsed.attrDefs) {
      applyAttribute(attributes, def);
    }
    for (const rawTarget of parsed.includes) {
      includeRecords.push({ from: file, rawTarget, done: false });
    }
    return content;
  };

  await readAndIngest(normalizedRoot);

  // Fixpoint: resolve includes; each newly read file can add attributes and more
  // includes, which may let previously-deferred includes resolve on a later pass.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < includeRecords.length; i++) {
      const record = includeRecords[i] as IncludeRecord;
      if (record.done) {
        continue;
      }

      const substituted = substituteAttributes(record.rawTarget, attributes);
      if (substituted === null) {
        // An attribute is still unknown. Defer; a later file may define it.
        continue;
      }

      const resolvedPath = resolveIncludePath(baseRoot, record.from, substituted);
      if (resolvedPath === null) {
        record.done = true;
        progressed = true;
        recordUnresolved(record.from, record.rawTarget, REASON_ESCAPES_ROOT);
        continue;
      }

      const content = await readAndIngest(resolvedPath);
      record.done = true;
      progressed = true;
      if (content === null) {
        recordUnresolved(record.from, record.rawTarget, REASON_NOT_FOUND);
        continue;
      }
      sources.add(resolvedPath);
    }
  }

  // Anything still pending never had its attributes resolved anywhere in the closure.
  for (const record of includeRecords) {
    if (!record.done) {
      recordUnresolved(record.from, record.rawTarget, REASON_UNRESOLVED_ATTR);
    }
  }

  return {
    sources: [...sources].sort(),
    unresolved: [...unresolved.values()].sort((a, b) =>
      a.from === b.from ? a.target.localeCompare(b.target) : a.from.localeCompare(b.from),
    ),
  };
}
