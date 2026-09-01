/**
 * Rendered-finding to AsciiDoc source mapping (docs Phase C).
 *
 * axe and the docs rulepack report a rendered DOM node: an outerHTML snippet plus a target
 * selector. The person who fixes it edits AsciiDoc. This module bridges that gap so a finding
 * "speaks source": it names the source file and the author's own construct (image::, link:,
 * a `=` heading marker) and phrases the fix in that markup, never a DOM selector or an axe rule id.
 *
 * Three tiers, best first (see the design's section 3.5):
 *   1. renderer  - the element carries data-source-file (and optionally data-source-line) that a
 *                  cooperating Asciidoctor sourcemap pass emitted. Exact file and line, trusted as is.
 *   2. content   - match the element's stable content back to source within the page's include
 *                  closure: an image by its filename, a link by its href, a heading by its text.
 *                  File and construct exact. No line, because a content match cannot honestly
 *                  claim one when a construct may repeat.
 *   3. fallback  - nothing matched. Attribute to the page's assembly file (its owning source) and
 *                  disclose the whole closure as candidates. Always available, never false-precise.
 *
 * Honesty invariants:
 * - Never guess a single owner when the content matches more than one source. `file` is a stable
 *   primary, `candidates` discloses every match, so ambiguity is visible, not hidden.
 * - Fail open. A missing or unreadable source file is skipped, never thrown. The worst case is a
 *   fallback mapping, which still points the author at the assembly.
 * - Line numbers only from the renderer tier. The content heuristic guarantees file and construct,
 *   not line, exactly as the design promises.
 */
// POSIX basename keeps filename comparison stable across operating systems and matches the
// forward-slash paths the include graph and git report.
import { posix as path } from "node:path";
import type { Draft, FsGlob } from "../contracts/index.js";

export type SourceMapTier = "renderer" | "content" | "fallback";

/**
 * The page an offending element belongs to, as coverage already knows it: the assembly (owning)
 * file plus the full include closure from buildAdocIncludeGraph. Content matching searches the
 * closure; fallback attributes to the assembly.
 */
export interface DocsPageClosure {
  assemblyFile: string;
  sources: string[];
}

export interface DocsSourceMapping {
  tier: SourceMapTier;
  // The primary attributed source file. Null only when a fallback has no assembly to name.
  file: string | null;
  // Every source that could own the construct: one for a unique match, several when ambiguous,
  // the whole closure for a fallback. Sorted for a stable primary and stable output.
  candidates: string[];
  // The author's markup, e.g. 'image::create-cluster.png' or '==== Advanced options'. Null on fallback.
  construct: string | null;
  // Exact source line, populated only by the renderer tier.
  line: number | null;
  // The fix, phrased in the format's own syntax where a construct is known, else the finding's own fix.
  fix: string;
}

type FindingKind = "image" | "link" | "heading" | "unknown";

// A single source file that owns the matched construct, and the construct exactly as written there.
interface ContentMatch {
  file: string;
  construct: string;
}

function extraHtml(finding: Draft): string | null {
  const html = finding.evidence.extra?.["html"];
  return typeof html === "string" ? html : null;
}

function tagOf(html: string): string | null {
  const match = /<\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(html);
  return match?.[1] ? match[1].toLowerCase() : null;
}

function attrOf(html: string, name: string): string | null {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`,
    "i",
  ).exec(html);
  if (!match) {
    return null;
  }
  return match[2] ?? match[3] ?? null;
}

function innerText(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function classify(finding: Draft, html: string | null): FindingKind {
  const tag = html === null ? null : tagOf(html);
  if (tag === "img") return "image";
  if (tag === "a") return "link";
  if (tag !== null && /^h[1-6]$/.test(tag)) return "heading";

  const rule = finding.rule.toLowerCase();
  if (rule.includes("image")) return "image";
  if (rule.includes("link")) return "link";
  if (rule.includes("heading")) return "heading";

  if (finding.role === "img") return "image";
  if (finding.role === "link") return "link";
  if (finding.role === "heading") return "heading";

  return "unknown";
}

// The last path segment, with any query or fragment stripped. A rendered src is the resolved
// filename; the source macro may carry a directory prefix, so ownership is decided by basename.
function fileName(reference: string): string {
  const withoutQuery = reference.split(/[?#]/)[0] ?? reference;
  return path.basename(withoutQuery);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The AsciiDoc image macro on one file's content whose target filename matches `basename`, or null.
// Handles both the block form (image::) and the inline form (image:), returning the macro verbatim.
function matchImage(content: string, basename: string): string | null {
  const macro = /\bimage(::?)([^[\r\n]*?)\[/g;
  let m: RegExpExecArray | null;
  while ((m = macro.exec(content)) !== null) {
    const colons = m[1] ?? "";
    const target = (m[2] ?? "").trim();
    if (fileName(target) === basename) {
      return `image${colons}${target}`;
    }
  }
  return null;
}

// The AsciiDoc link on one file's content, matched first by href then by visible text. Returns the
// link macro verbatim when it can be isolated, else the href itself so the finding still names the URL.
function matchLink(
  content: string,
  href: string | null,
  text: string,
): string | null {
  if (href !== null && href !== "" && content.includes(href)) {
    const escaped = escapeRegExp(href);
    const linkMacro = new RegExp(`link:${escaped}\\[[^\\]]*\\]`).exec(content);
    if (linkMacro?.[0]) {
      return linkMacro[0];
    }
    const bareMacro = new RegExp(`${escaped}\\[[^\\]]*\\]`).exec(content);
    if (bareMacro?.[0]) {
      return bareMacro[0];
    }
    return href;
  }
  if (text !== "" && content.includes(text)) {
    const textMacro = new RegExp(
      `\\[[^\\]]*${escapeRegExp(text)}[^\\]]*\\]`,
    ).exec(content);
    return textMacro?.[0] ?? text;
  }
  return null;
}

// The AsciiDoc heading line whose title equals `text`, returned verbatim (marker plus title), or null.
function matchHeading(content: string, text: string): string | null {
  for (const rawLine of content.split(/\r?\n/)) {
    const heading = /^(=+)\s+(.*\S)\s*$/.exec(rawLine.trim());
    if (heading && (heading[2] ?? "").trim() === text) {
      return `${heading[1] ?? ""} ${(heading[2] ?? "").trim()}`;
    }
  }
  return null;
}

function matchInContent(
  kind: FindingKind,
  content: string,
  needle: { basename: string; href: string | null; text: string },
): string | null {
  switch (kind) {
    case "image":
      return needle.basename === ""
        ? null
        : matchImage(content, needle.basename);
    case "link":
      return matchLink(content, needle.href, needle.text);
    case "heading":
      return needle.text === "" ? null : matchHeading(content, needle.text);
    default:
      return null;
  }
}

function readInteger(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

// The intended heading level: one deeper than the section above it (fromLevel + 1) when the finding
// carries it, else one shallower than the offending heading. AsciiDoc uses that many `=` markers.
function targetHeadingLevel(
  finding: Draft,
  currentMarkerLength: number,
): number {
  const fromLevel = finding.evidence.extra?.["fromLevel"];
  if (typeof fromLevel === "number" && Number.isInteger(fromLevel)) {
    return fromLevel + 1;
  }
  return Math.max(1, currentMarkerLength - 1);
}

function buildFix(
  kind: FindingKind,
  construct: string,
  finding: Draft,
  html: string | null,
): string {
  switch (kind) {
    case "image":
      return `Add alt text between the brackets in AsciiDoc, for example: ${construct}[Describe what the image shows and why it matters].`;
    case "link": {
      const href = html === null ? null : attrOf(html, "href");
      const example =
        href !== null && href !== ""
          ? `link:${href}[Describe where the link goes]`
          : "link:URL[Describe where the link goes]";
      return `Give the link descriptive text in AsciiDoc: write it as ${example}, not empty text, a bare URL, or "click here".`;
    }
    case "heading": {
      const marker = construct.split(/\s+/)[0] ?? "=";
      const title = construct.slice(marker.length).trim();
      const target = "=".repeat(targetHeadingLevel(finding, marker.length));
      return `In AsciiDoc, reduce the heading level so it nests under the section above: change "${construct}" to "${target} ${title}".`;
    }
    default:
      return finding.fix;
  }
}

function fallbackMapping(
  finding: Draft,
  closure: DocsPageClosure,
): DocsSourceMapping {
  return {
    tier: "fallback",
    file: closure.assemblyFile === "" ? null : closure.assemblyFile,
    candidates: [...closure.sources].sort(),
    construct: null,
    line: null,
    fix: finding.fix,
  };
}

/**
 * Map a rendered finding to its AsciiDoc source construct and a syntax-aware fix.
 * Never throws: a finding with no usable content, or a closure whose files cannot be read,
 * resolves to a fallback mapping pointed at the page's assembly file.
 */
export async function mapFindingToSource(
  finding: Draft,
  closure: DocsPageClosure,
  fs: Pick<FsGlob, "readFile">,
): Promise<DocsSourceMapping> {
  const html = extraHtml(finding);

  // Tier 1: an exact location the renderer already recorded. Trust it without reading source.
  if (html !== null) {
    const sourceFile = attrOf(html, "data-source-file");
    if (sourceFile !== null && sourceFile !== "") {
      return {
        tier: "renderer",
        file: sourceFile,
        candidates: [sourceFile],
        construct: null,
        line: readInteger(attrOf(html, "data-source-line")),
        fix: finding.fix,
      };
    }
  }

  const kind = classify(finding, html);
  if (kind === "unknown") {
    return fallbackMapping(finding, closure);
  }

  // Tier 2: match the element's stable content back to source within the include closure.
  const needle = {
    basename: html !== null ? fileName(attrOf(html, "src") ?? "") : "",
    href: html !== null ? attrOf(html, "href") : null,
    text: finding.elementName ?? (html !== null ? innerText(html) : ""),
  };

  const matches: ContentMatch[] = [];
  for (const file of [...closure.sources].sort()) {
    const content = await fs.readFile(file);
    if (content === null) {
      continue;
    }
    const construct = matchInContent(kind, content, needle);
    if (construct !== null) {
      matches.push({ file, construct });
    }
  }

  if (matches.length === 0) {
    return fallbackMapping(finding, closure);
  }

  // matches follow the sorted closure, so the first is the stable primary and candidates stay sorted.
  const primary = matches[0] as ContentMatch;
  return {
    tier: "content",
    file: primary.file,
    candidates: matches.map((match) => match.file),
    construct: primary.construct,
    line: null,
    fix: buildFix(kind, primary.construct, finding, html),
  };
}
