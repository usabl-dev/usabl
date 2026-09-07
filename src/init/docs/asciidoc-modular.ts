/**
 * Red Hat Pantheon adapter for `usabl init --docs`.
 * A Pantheon repo builds one guide per titles/<guide>/master.adoc, and each master
 * transcludes the assemblies that become rendered pages. This adapter reads each
 * master's direct include:: directives to find those assemblies, reads the anchor the
 * author wrote on each assembly for its pageId, and follows the real include closure
 * for its sources. It never mints a verdict. Anything it cannot measure (the rendered
 * url scheme, the build output directory) is emitted with a loud "Review:" note so the
 * operator treats it as a guess, not a fact.
 *
 * The block-aware line scan below mirrors parseAdoc in asciidoc-include-graph.ts so that
 * includes shown as code or commented out are ignored the same way. The include closure
 * itself is delegated to buildAdocIncludeGraph; only the master's direct children are
 * extracted here, because the closure alone cannot tell an assembly from a module.
 */
import { posix } from 'node:path';
import { buildAdocIncludeGraph } from '../../coverage/asciidoc-include-graph.js';
import type { DocsManifest, DocsPageEntry } from '../../coverage/docs-manifest.js';
import { validateId } from '../../intake/id-grammar.js';
import { slug } from '../../primitives/slug.js';
import { DOCS_INIT_REFUSAL, unusableIdsError, type UnusableId } from '../unusable-ids.js';
import type { DocsInitDraft, DocsInitFs } from './index.js';

const PANTHEON_MASTER_GLOB = 'titles/*/master.adoc';
const DEFAULT_BUILT_ROOT = 'build';
const DEFAULT_BUILD_COMMAND = 'ccutil compile';
const DOCS_BASE_URL = 'http://127.0.0.1:0';
// Candidate shared-asset globs. Only the ones that match a real file are emitted, so the
// draft does not point coverage at directories that do not exist in this repo.
const SHARED_GLOB_CANDIDATES = ['images/**', '**/images/**', 'snippets/**', '**/snippets/**'];

// A block delimiter line is four or more of a single delimiter character and nothing else.
function isDelimiterLine(trimmed: string, char: string): boolean {
  if (trimmed.length < 4) return false;
  for (const c of trimmed) {
    if (c !== char) return false;
  }
  return true;
}

// Listing (----), literal (....), and passthrough (++++) blocks are verbatim: includes and
// anchors inside them are sample text, not directives. This matches asciidoc-include-graph.ts.
function verbatimDelimiterOf(trimmed: string): string | null {
  for (const char of ['-', '.', '+']) {
    if (isDelimiterLine(trimmed, char)) return char;
  }
  return null;
}

// The trimmed lines that are real content: outside //// comment blocks, outside verbatim
// blocks, and not // line comments. Directive matching runs only on these.
function contentLines(content: string): string[] {
  const out: string[] = [];
  let inCommentBlock = false;
  let openVerbatim: string | null = null;
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (inCommentBlock) {
      if (isDelimiterLine(trimmed, '/')) inCommentBlock = false;
      continue;
    }
    if (openVerbatim !== null) {
      if (trimmed === openVerbatim) openVerbatim = null;
      continue;
    }
    if (isDelimiterLine(trimmed, '/')) {
      inCommentBlock = true;
      continue;
    }
    if (verbatimDelimiterOf(trimmed) !== null) {
      openVerbatim = trimmed;
      continue;
    }
    if (trimmed.startsWith('//')) continue;
    out.push(trimmed);
  }
  return out;
}

// A real include is its own line: include::TARGET[OPTS]. Options are ignored for paths.
// Same recognition rule as asciidoc-include-graph.ts.
function matchIncludeTarget(trimmed: string): string | null {
  const match = /^include::([^[]+)\[[^\]]*\]\s*$/.exec(trimmed);
  if (!match || match[1] === undefined) return null;
  return match[1].trim();
}

// The author-written block anchor, recognized in every form Pantheon uses. Returns the raw
// anchor value; whether it is a valid pageId is decided by the id grammar where the page is
// made, not here. Returns null when no anchor is present.
function matchAnchor(line: string): string | null {
  if (!line.startsWith('[')) return null;
  const idQuoted = /^\[id=(?:"([^"]+)"|'([^']+)')/.exec(line);
  if (idQuoted) {
    const value = idQuoted[1] ?? idQuoted[2];
    return value !== undefined && value.length > 0 ? value : null;
  }
  const idBare = /^\[id=([^\],\s"']+)\]/.exec(line);
  if (idBare && idBare[1] !== undefined && idBare[1].length > 0) return idBare[1];
  const hash = /^\[#([A-Za-z0-9_][A-Za-z0-9_:-]*)/.exec(line);
  if (hash && hash[1] !== undefined && hash[1].length > 0) return hash[1];
  const legacy = /^\[\[([^\],]+)/.exec(line);
  if (legacy && legacy[1] !== undefined) {
    const value = legacy[1].trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function findAnchorId(content: string): string | null {
  for (const line of contentLines(content)) {
    const anchor = matchAnchor(line);
    if (anchor !== null) return anchor;
  }
  return null;
}

// Resolve TARGET relative to the including file's directory and reject any escape from the
// repo root, mirroring expectSafeRelativePath in docs-manifest.ts. Returns null on escape.
function resolveRepoPath(fromFile: string, target: string): string | null {
  const resolved = posix.normalize(posix.join(posix.dirname(fromFile), target));
  if (resolved.startsWith('..') || posix.isAbsolute(resolved)) return null;
  return resolved;
}

function fileBaseSlug(filePath: string): string {
  const base = posix.basename(filePath).replace(/\.adoc$/i, '');
  return slug(base);
}

async function discoverSharedGlobs(fs: DocsInitFs): Promise<string[]> {
  const found: string[] = [];
  for (const pattern of SHARED_GLOB_CANDIDATES) {
    if ((await fs.glob([pattern])).length > 0) found.push(pattern);
  }
  // A draft with no shared globs would silently drop shared-image coverage, so fall back to
  // the most common location and let the Review note tell the operator to confirm it.
  return found.length > 0 ? found : ['images/**'];
}

export async function inferAsciidocModular(fs: DocsInitFs): Promise<DocsInitDraft> {
  const notes: string[] = [];
  const pages: DocsPageEntry[] = [];
  const unusable: UnusableId[] = [];
  const usedPageIds = new Set<string>();

  const uniquePageId = (candidate: string): string => {
    if (!usedPageIds.has(candidate)) {
      usedPageIds.add(candidate);
      return candidate;
    }
    let suffix = 2;
    while (usedPageIds.has(`${candidate}-${suffix}`)) suffix += 1;
    const deduped = `${candidate}-${suffix}`;
    usedPageIds.add(deduped);
    notes.push(
      `Review: two assemblies resolved to pageId "${candidate}". The second was renamed "${deduped}". Confirm the ids before you commit this file.`,
    );
    return deduped;
  };

  const masters = (await fs.glob([PANTHEON_MASTER_GLOB])).sort();
  for (const master of masters) {
    const masterContent = await fs.readFile(master);
    if (masterContent === null) continue;
    const titleDir = posix.basename(posix.dirname(master));

    for (const line of contentLines(masterContent)) {
      const target = matchIncludeTarget(line);
      if (target === null) continue;

      const assemblyFile = resolveRepoPath(master, target);
      if (assemblyFile === null) {
        notes.push(`Review: include "${target}" in ${master} escapes the repo root and was skipped.`);
        continue;
      }
      const assemblyContent = await fs.readFile(assemblyFile);
      if (assemblyContent === null) {
        notes.push(`Review: include "${target}" in ${master} points at a missing file and was skipped.`);
        continue;
      }

      const anchor = findAnchorId(assemblyContent);
      const candidate = anchor ?? fileBaseSlug(assemblyFile);
      // Ask the question the sidecar parser is going to ask, at the point the id is made. An
      // anchor is authored text and can carry a raw space, a joining character, or a blank glyph,
      // and a filename slug can come out empty, so writing either would produce a manifest usabl
      // then refuses to read. The page is not skipped either: a manifest without it would let a
      // shared-file change look fully checked while the page is never scanned. Every such page is
      // collected so the whole draft can be refused at once, naming each one.
      const refusal = validateId(candidate);
      if (!refusal.ok) {
        unusable.push({
          source: assemblyFile,
          origin: anchor !== null ? 'its anchor pageId' : 'the pageId guessed from its filename',
          refusal,
        });
        continue;
      }
      const pageId = uniquePageId(candidate);
      if (anchor === null) {
        notes.push(
          `Review: no anchor found in ${assemblyFile}. The pageId "${pageId}" was guessed from the filename. Confirm it before you commit this file.`,
        );
      }

      const graph = await buildAdocIncludeGraph(fs, assemblyFile);
      for (const gap of graph.unresolved) {
        notes.push(`Review: unresolved include in ${gap.from}: "${gap.target}" (${gap.reason}).`);
      }

      const url = `/${slug(titleDir)}/${fileBaseSlug(assemblyFile)}/index.html`;
      pages.push({ pageId, url, assemblyFile, sources: graph.sources });
    }
  }

  // Refuse before the empty check, because a guide whose every page is unusable is empty for a
  // reason the operator can fix, and that reason is the one to print.
  if (unusable.length > 0) {
    throw unusableIdsError(DOCS_INIT_REFUSAL, unusable);
  }

  if (pages.length === 0) {
    throw new Error(
      'usabl init --docs found Pantheon guide masters but no assembly resolved into a page. Check the include:: paths in your titles/*/master.adoc files.',
    );
  }

  notes.push(
    `Review: docsBaseUrl uses port 0, so usabl serves builtRoot on an ephemeral local port at run time. Change it if you host the built docs elsewhere.`,
  );
  notes.push(
    `Review: builtRoot defaults to "${DEFAULT_BUILT_ROOT}". You MUST confirm the real ${DEFAULT_BUILD_COMMAND} output directory before you commit this file.`,
  );
  notes.push(
    `Review: buildCommand defaults to "${DEFAULT_BUILD_COMMAND}". Confirm it matches how you build these docs.`,
  );
  notes.push(
    `Review: page urls are a best-effort guess of the ${DEFAULT_BUILD_COMMAND} output layout. You MUST verify every url against the real build output before you commit this file.`,
  );
  notes.push(`Review: sharedGlobs are defaults. Confirm they cover your shared images and snippets.`);
  notes.push(
    `Review: this is a draft. Merge it only after you confirm every pageId, url, builtRoot, and source list.`,
  );

  const manifest: DocsManifest = {
    format: 'asciidoc-modular',
    docsBaseUrl: DOCS_BASE_URL,
    builtRoot: DEFAULT_BUILT_ROOT,
    buildCommand: DEFAULT_BUILD_COMMAND,
    pages,
    sharedGlobs: await discoverSharedGlobs(fs),
  };

  return { manifest, notes };
}
