import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline documentation link checker. It validates relative links and local
// file references inside the docs corpus, plus intra-page and cross-page
// `#anchor` fragments where the target file can be parsed. External http(s)
// URLs (and other schemes such as mailto and tel) are reported as skipped, not
// fetched, so the check stays deterministic and does not touch the network.

const ROOT_DOCS = ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];
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

function extractLinks(filePath, content) {
  const ext = extname(filePath).toLowerCase();
  const links = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (ext === '.md') {
      if (stripFence(line)) {
        inFence = !inFence;
        return;
      }
      if (!inFence) {
        // Markdown inline links and images: [text](target) / ![alt](target),
        // allowing an optional "title" after the target.
        for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*([^)\s]+?)(?:\s+["'][^"']*["'])?\s*\)/g)) {
          links.push({ target: match[1], lineNumber });
        }
      }
    }

    // href/src attributes appear in HTML files and in raw HTML inside markdown.
    for (const match of line.matchAll(/(?:href|src)\s*=\s*"([^"]*)"/gi)) {
      links.push({ target: match[1], lineNumber });
    }
    for (const match of line.matchAll(/(?:href|src)\s*=\s*'([^']*)'/gi)) {
      links.push({ target: match[1], lineNumber });
    }
  });

  return links;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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

    for (const { target, lineNumber } of links) {
      const raw = target.trim();
      if (raw === '') continue;

      if (EXTERNAL_PREFIX.test(raw)) {
        externalCount += 1;
        continue;
      }

      const hashIndex = raw.indexOf('#');
      const pathPart = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? '' : raw.slice(hashIndex + 1);

      // Pure fragment: resolve against the current file's own anchors.
      if (pathPart === '') {
        checkedCount += 1;
        if (fragment !== '' && !anchorResolves(anchors, safeDecode(fragment))) {
          broken.push({ relFile, lineNumber, target: raw, reason: 'missing anchor' });
        }
        continue;
      }

      checkedCount += 1;
      const targetPath = resolve(dirname(file), safeDecode(pathPart));
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
        if (!anchorResolves(targetAnchors, safeDecode(fragment))) {
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

// extractLinks and EXTERNAL_PREFIX are shared with the staged link check so both
// passes agree on what counts as a link and what counts as external.
export { checkDocLinks, collectAnchors, extractLinks, EXTERNAL_PREFIX, slugify };
