import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE_BASE_PATH } from './stage-public-pages.mjs';

// Offline documentation link checker over the source tree. It validates
// relative links and local file references inside the docs corpus, plus
// intra-page and cross-page `#anchor` fragments where the target file can be
// parsed. External http(s) URLs (and other schemes such as mailto and tel) are
// reported as skipped, not fetched, so the check stays deterministic and does
// not touch the network. In markdown it reads inline links, reference-style
// links resolved through their definitions, and autolinks; in every file it
// reads HTML URL attributes and CSS url() references.
//
// The docs:linkcheck command runs this pass and then the staged pass in
// check-staged-links.mjs, and both must pass. They check different properties.
// This pass checks that every link in the whole corpus, markdown included,
// names a file or anchor that exists in the repository. The staged pass checks
// that every link on a published page names a file and anchor in the deployed
// set. Neither pass is a superset of the other; the composite command is the
// contract. The two passes share link extraction and target normalization so
// they agree on what a link names.
//
// Root-absolute links follow the published site. The docs directory is the
// site root and is served under SITE_BASE_PATH, so `/usabl/page.html` names
// docs/page.html, and a root-absolute link outside that prefix is broken.

const ROOT_DOCS = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
];
// The directory that becomes the site root once staged.
const SITE_SOURCE_DIR = 'docs';
const CORPUS_EXTENSIONS = new Set(['.md', '.html']);
const ANCHOR_EXTENSIONS = new Set(['.md', '.html']);

// A leading scheme (http:, https:, mailto:, tel:, data:, ...) or a
// protocol-relative `//host` prefix marks a target as external. We do not
// fetch these; we only count and disclose them.
const EXTERNAL_PREFIX = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walkCorpus(root) {
  const files = [];

  async function walkDir(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(full);
      } else if (entry.isFile() && CORPUS_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(full);
      }
    }
  }

  await walkDir(join(root, 'docs'));
  for (const name of ROOT_DOCS) {
    const full = join(root, name);
    if (await pathExists(full)) {
      files.push(full);
    }
  }
  return files.sort();
}

// GitHub-style heading slug: lowercase, drop punctuation other than spaces and
// hyphens, then turn runs of whitespace into single hyphens.
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

function stripFence(line) {
  return /^\s*(```|~~~)/.test(line);
}

// Collect the set of anchors a file exposes: heading slugs for markdown plus any
// explicit id/name attributes, and id/name attributes for HTML.
function collectAnchors(filePath, content) {
  const anchors = new Set();
  const ext = extname(filePath).toLowerCase();

  if (ext === '.md') {
    let inFence = false;
    for (const line of content.split(/\r?\n/)) {
      if (stripFence(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading && heading[1]) {
        anchors.add(slugify(heading[1]));
      }
    }
  }

  for (const match of content.matchAll(/(?:id|name)\s*=\s*"([^"]+)"/gi)) {
    anchors.add(match[1]);
  }
  for (const match of content.matchAll(/(?:id|name)\s*=\s*'([^']+)'/gi)) {
    anchors.add(match[1]);
  }

  return anchors;
}

// Attributes whose whole value is one URL. `data` is the <object> source and
// `poster` the <video> preview image. The leading boundary keeps data-* and
// names such as metadata from matching. Values must be quoted; a quoted value
// may span lines, since `[^"]` matches a newline. Unquoted attribute values are
// not extracted. Every page in this corpus quotes its attributes, so that gap
// is accepted rather than handled with a partial parser.
const URL_ATTRIBUTE = /(?<![\w-])(?:href|src|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
// srcset holds comma-separated candidates, each a URL followed by an optional
// width or density descriptor.
const SRCSET_ATTRIBUTE = /(?<![\w-])srcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
// Inline style attributes and <style> blocks can reference files through
// url(...), and a <style> block can also pull in a sheet with the string form
// `@import "sheet.css"`. SVG presentation attributes such as
// marker-end="url(#id)" are not style contexts and are not scanned; the corpus
// only uses same-document forms there, and a future presentation attribute
// naming a file, such as url(markers.svg#id), would not be checked.
const STYLE_ATTRIBUTE = /(?<![\w-])style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const STYLE_BLOCK = /<style[\s>][\s\S]*?<\/style\s*>/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')\s]+))\s*\)/gi;
const CSS_IMPORT_STRING = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
// Markdown inline links and images: [text](target) / ![alt](target), allowing
// an optional "title" after the target.
const MARKDOWN_LINK = /!?\[[^\]]*\]\(\s*([^)\s]+?)(?:\s+["'][^"']*["'])?\s*\)/g;
// A link reference definition: `[label]: target` with an optional title, on a
// line of its own, indented at most three spaces. The target may be wrapped in
// angle brackets, which is how a target with spaces is written.
const REFERENCE_DEFINITION =
  /^ {0,3}\[((?:[^[\]\\]|\\.)+)\]:[ \t]*(?:<([^<>\n]*)>|(\S+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
// A reference link or image: `[text][label]` (full), `[label][]` (collapsed),
// or `[label]` (shortcut). An escaped opening bracket starts no link. A bracket
// pair followed by `(` is an inline link, which MARKDOWN_LINK reads.
const REFERENCE_USE = /(?<!\\)!?\[((?:[^[\]\\]|\\.)*)\](?:\[((?:[^[\]\\]|\\.)*)\])?(?!\()/g;
// Autolinks. A CommonMark autolink is an absolute URI or an email address in
// angle brackets, and both are external. A relative target in angle brackets,
// starting with `./`, `../`, `/`, or `#`, is read too, so a link written that
// way is checked rather than passed over. HTML tags never start that way, except
// a closing tag such as `</p>`, which is left out by its shape.
const AUTOLINK_URI = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/g;
const AUTOLINK_EMAIL =
  /<([A-Za-z0-9.!#$%&'*+/=?^_{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/g;
const AUTOLINK_RELATIVE = /<((?:\.{1,2}\/|\/|#)[^\s<>]*)>/g;
const CLOSING_TAG = /^\/[A-Za-z][A-Za-z0-9-]*$/;

function quotedValue(match) {
  return match[1] ?? match[2] ?? '';
}

// Offset of a quoted attribute value inside the text the match came from. The
// match ends with the closing quote, so the value sits just before it.
function quotedValueOffset(match) {
  return match.index + match[0].length - 1 - quotedValue(match).length;
}

// Each extractor below returns { url, offset } pairs, with offset relative to
// the text it was given, so the caller can report the line the URL is on even
// when the surrounding value spans lines.
function cssUrls(text) {
  const urls = [];
  for (const match of text.matchAll(CSS_URL)) {
    const url = match[1] ?? match[2] ?? match[3] ?? '';
    if (url !== '') urls.push({ url, offset: match.index + match[0].indexOf(url, 4) });
  }
  return urls;
}

function cssImportStrings(text) {
  const urls = [];
  for (const match of text.matchAll(CSS_IMPORT_STRING)) {
    const url = quotedValue(match);
    if (url !== '') urls.push({ url, offset: quotedValueOffset(match) });
  }
  return urls;
}

// Parse srcset the way the HTML srcset algorithm does. A candidate URL is a run
// of non-whitespace characters, so a comma inside a data URL stays part of the
// URL; only a comma that ends that run, or a comma after the descriptors,
// separates candidates. Splitting on every comma would cut a data URL apart and
// report its payload as a missing file.
function srcsetUrls(value) {
  const urls = [];
  const length = value.length;
  let index = 0;
  while (index < length) {
    while (index < length && /[\s,]/.test(value[index])) index += 1;
    if (index >= length) break;

    const start = index;
    while (index < length && !/\s/.test(value[index])) index += 1;
    let url = value.slice(start, index);

    const trailingCommas = /,+$/.exec(url);
    if (trailingCommas) {
      // The comma ended the URL run, so this candidate has no descriptors.
      url = url.slice(0, url.length - trailingCommas[0].length);
    } else {
      // Skip the descriptors up to the next comma outside parentheses.
      let depth = 0;
      while (index < length) {
        const char = value[index];
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        else if (char === ',' && depth === 0) break;
        index += 1;
      }
    }
    if (url !== '') urls.push({ url, offset: start });
  }
  return urls;
}

// CommonMark matches a reference label without regard to case, and treats any
// run of whitespace inside it as one space.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

// The same line with every inline code span blanked out, character for
// character, so offsets still line up. Text in a code span is an example, not a
// link. A backtick run with no closing run of the same length is literal text.
function maskCodeSpans(line) {
  let out = '';
  let index = 0;
  while (index < line.length) {
    if (line[index] !== '`') {
      out += line[index];
      index += 1;
      continue;
    }
    let runEnd = index;
    while (runEnd < line.length && line[runEnd] === '`') runEnd += 1;
    const run = line.slice(index, runEnd);
    let close = line.indexOf(run, runEnd);
    while (close !== -1 && line[close + run.length] === '`') {
      let next = close;
      while (next < line.length && line[next] === '`') next += 1;
      close = line.indexOf(run, next);
    }
    if (close === -1) {
      out += run;
      index = runEnd;
      continue;
    }
    out += ' '.repeat(close + run.length - index);
    index = close + run.length;
  }
  return out;
}

// Reference links, reference images, and autolinks in a markdown file, outside
// fenced code. Returns the targets they name with their offsets, and the full or
// collapsed references whose label has no definition. A shortcut `[label]` with
// no definition renders as plain text, a task box or a bracketed word, so it is
// not a link and is not reported. A definition that nothing uses renders nothing
// and is not checked.
function markdownReferences(content) {
  const lines = content.split('\n');
  const definitions = new Map();
  let inFence = false;
  for (const line of lines) {
    if (stripFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const definition = REFERENCE_DEFINITION.exec(line);
    if (definition) {
      const label = normalizeLabel(definition[1]);
      // The first definition of a label wins, as it does in CommonMark.
      if (label !== '' && !definitions.has(label)) {
        definitions.set(label, definition[2] ?? definition[3] ?? '');
      }
    }
  }

  const links = [];
  const undefinedReferences = [];
  inFence = false;
  let offset = 0;
  for (const line of lines) {
    if (stripFence(line)) {
      inFence = !inFence;
    } else if (!inFence && !REFERENCE_DEFINITION.test(line)) {
      const masked = maskCodeSpans(line);
      for (const match of masked.matchAll(REFERENCE_USE)) {
        const written = match[2] === undefined || match[2] === '' ? match[1] : match[2];
        const explicit = match[2] !== undefined;
        const target = definitions.get(normalizeLabel(written));
        if (target !== undefined) {
          links.push({ url: target, offset: offset + match.index });
        } else if (explicit && normalizeLabel(written) !== '') {
          undefinedReferences.push({ label: written, offset: offset + match.index });
        }
      }
      for (const match of masked.matchAll(AUTOLINK_URI)) {
        links.push({ url: match[1], offset: offset + match.index + 1 });
      }
      for (const match of masked.matchAll(AUTOLINK_EMAIL)) {
        // An email autolink is a mailto link, so it is counted as external.
        links.push({ url: `mailto:${match[1]}`, offset: offset + match.index + 1 });
      }
      for (const match of masked.matchAll(AUTOLINK_RELATIVE)) {
        if (CLOSING_TAG.test(match[1])) continue;
        links.push({ url: match[1], offset: offset + match.index + 1 });
      }
    }
    offset += line.length + 1;
  }
  return { links, undefinedReferences };
}

// Map a character offset in the file to its 1-based line number.
function lineIndexer(content) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

// Extract every link target in a file with the line it starts on. HTML is
// scanned as one string, not line by line, so a quoted value that spans lines
// (a wrapped srcset, an href broken after the `=`) is read whole; a line-based
// scan would never see the closing quote and would silently drop the link.
function extractLinks(filePath, content) {
  const ext = extname(filePath).toLowerCase();
  const lineAt = lineIndexer(content);
  const links = [];
  const pushAt = (target, offset) => links.push({ target, lineNumber: lineAt(offset), offset });

  if (ext === '.md') {
    // Markdown links never span lines, and fenced code must be skipped, so
    // these are read line by line while tracking the running offset.
    let inFence = false;
    let offset = 0;
    for (const line of content.split('\n')) {
      if (stripFence(line)) {
        inFence = !inFence;
      } else if (!inFence) {
        for (const match of line.matchAll(MARKDOWN_LINK)) {
          pushAt(match[1], offset + match.index);
        }
      }
      offset += line.length + 1;
    }
    for (const { url, offset: at } of markdownReferences(content).links) pushAt(url, at);
  }

  // HTML attributes appear in HTML files and in raw HTML inside markdown.
  for (const match of content.matchAll(URL_ATTRIBUTE)) {
    pushAt(quotedValue(match), quotedValueOffset(match));
  }
  for (const match of content.matchAll(SRCSET_ATTRIBUTE)) {
    const start = quotedValueOffset(match);
    for (const { url, offset } of srcsetUrls(quotedValue(match))) pushAt(url, start + offset);
  }

  // CSS url(...) and string-form @import inside <style> blocks, then url(...)
  // inside inline style attributes outside those blocks.
  const styleRanges = [];
  for (const block of content.matchAll(STYLE_BLOCK)) {
    styleRanges.push([block.index, block.index + block[0].length]);
    for (const { url, offset } of cssUrls(block[0])) pushAt(url, block.index + offset);
    for (const { url, offset } of cssImportStrings(block[0])) pushAt(url, block.index + offset);
  }
  for (const match of content.matchAll(STYLE_ATTRIBUTE)) {
    if (styleRanges.some(([from, to]) => match.index >= from && match.index < to)) continue;
    const start = quotedValueOffset(match);
    for (const { url, offset } of cssUrls(quotedValue(match))) pushAt(url, start + offset);
  }

  return links
    .sort((a, b) => a.offset - b.offset)
    .map(({ target, lineNumber }) => ({ target, lineNumber }));
}

// Full and collapsed references in a markdown file whose label is never
// defined, with the line each one is on. Such a reference is meant as a link and
// renders as plain text, so it is reported as broken.
function findUndefinedReferences(filePath, content) {
  if (extname(filePath).toLowerCase() !== '.md') return [];
  const lineAt = lineIndexer(content);
  return markdownReferences(content).undefinedReferences.map(({ label, offset }) => ({
    label,
    lineNumber: lineAt(offset),
  }));
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Split a link target into the path the server resolves and the fragment the
// browser resolves. The query string is dropped: it never changes which static
// file is served, so `page.html?v=2` names page.html.
//
// `rawPath` is the path as written and is what syntax decisions are made on: a
// leading `/` or the site base path means something only before decoding, so
// `%2Fpage.html` is a relative link, not a root-absolute one. `path` is the
// percent-decoded form for the filesystem lookup, so `a%20b.md` matches
// `a b.md` on disk and `%2F` matches the slash the server decodes it to. Both
// passes use this so they agree on what file a link names.
function splitLinkTarget(raw) {
  const hashIndex = raw.indexOf('#');
  const beforeFragment = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : raw.slice(hashIndex + 1);
  const queryIndex = beforeFragment.indexOf('?');
  const rawPath = queryIndex === -1 ? beforeFragment : beforeFragment.slice(0, queryIndex);
  return { rawPath, path: safeDecode(rawPath), fragment: safeDecode(fragment) };
}

// For a root-absolute raw path, return the part under the site base path, or
// null when the path does not start with the base path and so never reaches the
// site. `/usabl/` and `/usabl` both name the site root and return ''.
function siteRootedPath(rawPath) {
  const base = SITE_BASE_PATH.replace(/\/$/, '');
  if (rawPath === base) return '';
  if (rawPath.startsWith(SITE_BASE_PATH)) return rawPath.slice(SITE_BASE_PATH.length);
  return null;
}

function anchorResolves(anchors, fragment) {
  if (anchors.has(fragment)) return true;
  const lower = fragment.toLowerCase();
  for (const anchor of anchors) {
    if (anchor.toLowerCase() === lower) return true;
  }
  return false;
}

async function checkDocLinks(root) {
  const files = await walkCorpus(root);
  const anchorCache = new Map();
  const contentCache = new Map();

  async function readCached(path) {
    if (!contentCache.has(path)) {
      contentCache.set(path, await readFile(path, 'utf8'));
    }
    return contentCache.get(path);
  }

  async function anchorsFor(path) {
    if (!anchorCache.has(path)) {
      const content = await readCached(path);
      anchorCache.set(path, collectAnchors(path, content));
    }
    return anchorCache.get(path);
  }

  const broken = [];
  const escaped = [];
  let externalCount = 0;
  let checkedCount = 0;

  for (const file of files) {
    const content = await readCached(file);
    const anchors = await anchorsFor(file);
    const links = extractLinks(file, content);
    const relFile = relative(root, file).split('\\').join('/');

    for (const { label, lineNumber } of findUndefinedReferences(file, content)) {
      broken.push({ relFile, lineNumber, target: `[${label}]`, reason: 'undefined link reference' });
    }

    for (const { target, lineNumber } of links) {
      const raw = target.trim();
      if (raw === '') continue;

      if (EXTERNAL_PREFIX.test(raw)) {
        externalCount += 1;
        continue;
      }

      const { rawPath, path: pathPart, fragment } = splitLinkTarget(raw);

      // Pure fragment: resolve against the current file's own anchors.
      if (rawPath === '') {
        checkedCount += 1;
        if (fragment !== '' && !anchorResolves(anchors, fragment)) {
          broken.push({ relFile, lineNumber, target: raw, reason: 'missing anchor' });
        }
        continue;
      }

      checkedCount += 1;
      let targetPath;
      if (rawPath.startsWith('/')) {
        // Root-absolute: valid only under the site base path, where it names a
        // file in the site source directory. Anything else leaves the site.
        const siteRooted = siteRootedPath(rawPath);
        if (siteRooted === null) {
          broken.push({
            relFile,
            lineNumber,
            target: raw,
            reason: `root-absolute path outside the site base path ${SITE_BASE_PATH}`,
          });
          continue;
        }
        targetPath = join(root, SITE_SOURCE_DIR, safeDecode(siteRooted));
      } else {
        // join, not resolve: a decoded path may begin with a slash (from %2F)
        // and must still be read relative to the linking file, as the server does.
        targetPath = join(dirname(file), pathPart);
      }
      if (!(await pathExists(targetPath))) {
        broken.push({ relFile, lineNumber, target: raw, reason: 'file not found' });
        continue;
      }

      // A target that resolves on this filesystem but sits outside the corpus
      // root would break in a clean clone. Disclose it as its own category
      // instead of blessing it, but do not fail the build on it here.
      const withinRoot = relative(root, targetPath);
      if (withinRoot !== '' && (withinRoot.startsWith('..') || isAbsolute(withinRoot))) {
        escaped.push({ relFile, lineNumber, target: raw });
        continue;
      }

      // Cross-file fragment: resolve against the target file when we can parse it.
      if (fragment !== '' && ANCHOR_EXTENSIONS.has(extname(targetPath).toLowerCase())) {
        const targetAnchors = await anchorsFor(targetPath);
        if (!anchorResolves(targetAnchors, fragment)) {
          broken.push({ relFile, lineNumber, target: raw, reason: 'missing anchor' });
        }
      }
    }
  }

  return { files, broken, escaped, externalCount, checkedCount };
}

async function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  const { files, broken, escaped, externalCount, checkedCount } = await checkDocLinks(root);

  for (const entry of broken) {
    process.stdout.write(`${entry.relFile}:${entry.lineNumber}: ${entry.reason}: ${entry.target}\n`);
  }
  for (const entry of escaped) {
    process.stdout.write(`${entry.relFile}:${entry.lineNumber}: escapes repo root: ${entry.target}\n`);
  }

  process.stdout.write(
    `\nScanned ${files.length} file(s): ${checkedCount} relative link(s) checked, ` +
      `${externalCount} external URL(s) skipped (not checked), ${broken.length} broken.\n`,
  );
  if (escaped.length > 0) {
    process.stdout.write(
      `${escaped.length} link(s) escape the repo root (resolved locally, would break in a clean clone).\n`,
    );
  }

  process.exit(broken.length > 0 ? 1 : 0);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`check-doc-links failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}

// extractLinks, splitLinkTarget, siteRootedPath, and EXTERNAL_PREFIX are shared
// with the staged link check so both passes agree on what counts as a link,
// what file a link names, and what counts as external.
export {
  anchorResolves,
  checkDocLinks,
  collectAnchors,
  extractLinks,
  EXTERNAL_PREFIX,
  findUndefinedReferences,
  siteRootedPath,
  slugify,
  splitLinkTarget,
};
