import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  anchorResolves,
  collectAnchors,
  extractLinks,
  EXTERNAL_PREFIX,
  siteRootedPath,
  splitLinkTarget,
} from './check-doc-links.mjs';
import { SITE_BASE_PATH, stagePublicPages } from './stage-public-pages.mjs';

// Link check over the published Pages artifact.
//
// The Pages deploy stages only an allowlist of files, so a page can link a file
// that exists in the repository and still 404 on the published site. This pass
// stages the exact deploy artifact into a temporary directory, then requires
// every internal link in every staged HTML file to name a file in the staged
// set and, when the link carries a fragment, an id or name in that staged file.
//
// The docs:linkcheck command runs the source-tree pass in check-doc-links.mjs
// and then this pass, and both must pass. They check different properties: the
// source pass covers the whole corpus against the repository, this pass covers
// the published pages against the deployed set. Neither is a superset of the
// other; the composite command is the contract. Link extraction and target
// normalization are shared so the two passes agree on what a link names.
//
// Resolution follows the browser. A relative link resolves against the linking
// page's directory. A directory reference (`.`, `./`, `demo/`, `demo`) is served
// as that directory's index.html, and a fragment on it is looked up there. A
// root-absolute link resolves against the domain root: under the site base path
// (`/usabl/page.html`) it names a staged file, and outside it (`/page.html`) it
// never reaches the site and is reported as broken. Syntax is judged on the
// path as written, before percent-decoding, so `%2Fpage.html` is a relative
// link, as it is in the browser. A link that climbs above the staged root is
// reported as missing. A same-page `#fragment` is checked against the page's
// own anchors. External URLs and data URIs are skipped; staging does not
// affect them.

// Classify a link target written in one staged page.
//   { kind: 'skip' }                        not a file reference (external, data, empty)
//   { kind: 'root-absolute' }               starts with `/` but not with the site base path
//   { kind: 'file', file, index, fragment } candidate staged paths: the file itself (empty for
//                                           a directory reference) and that directory's
//                                           index.html, plus the decoded fragment or ''
function resolveStagedTarget(page, rawTarget) {
  const raw = rawTarget.trim();
  if (raw === '' || EXTERNAL_PREFIX.test(raw)) return { kind: 'skip' };

  const { rawPath, path, fragment } = splitLinkTarget(raw);
  if (rawPath === '') {
    // Same-page reference: the page itself is always staged, so only the
    // fragment can fail. A bare `#` names the page top and needs no anchor.
    if (fragment === '') return { kind: 'skip' };
    return { kind: 'file', file: page, index: `${page}/index.html`, fragment };
  }

  // Root-absolute links resolve from the staged root; relative links from the
  // page's directory. The decoded path is used for the lookup in both cases.
  let base = posix.dirname(page);
  let lookup = path;
  if (rawPath.startsWith('/')) {
    const siteRooted = siteRootedPath(rawPath);
    if (siteRooted === null) return { kind: 'root-absolute' };
    base = '.';
    lookup = decodeURIComponentSafe(siteRooted);
  }

  // Normalize to a path relative to the staged root. posix.join concatenates,
  // so a decoded leading slash still lands under the base. posix.normalize
  // keeps a trailing slash and returns `.` or `./` for the root itself.
  let resolved = posix.normalize(posix.join(base, lookup));
  if (resolved === '.') resolved = '';
  else if (resolved.startsWith('./')) resolved = resolved.slice(2);

  const isDirectory = resolved === '' || resolved.endsWith('/');
  const file = isDirectory ? '' : resolved;
  const index = isDirectory ? `${resolved}index.html` : `${resolved}/index.html`;
  return { kind: 'file', file, index, fragment };
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Check every staged HTML file. `stagedFiles` is the list of POSIX-relative
// paths the staging step reports, which is the set the site will actually
// serve. Returns the broken links plus counts for the summary line.
async function checkStagedLinks(stagedDir, stagedFiles) {
  const staged = new Set(stagedFiles);
  const pages = stagedFiles.filter((file) => file.toLowerCase().endsWith('.html'));
  const broken = [];
  let checkedCount = 0;
  let skippedCount = 0;

  const contentCache = new Map();
  const anchorCache = new Map();
  async function contentOf(file) {
    if (!contentCache.has(file)) {
      contentCache.set(file, await readFile(resolve(stagedDir, file), 'utf8'));
    }
    return contentCache.get(file);
  }
  async function anchorsOf(file) {
    if (!anchorCache.has(file)) {
      anchorCache.set(file, collectAnchors(file, await contentOf(file)));
    }
    return anchorCache.get(file);
  }

  for (const page of pages) {
    const content = await contentOf(page);
    for (const { target, lineNumber } of extractLinks(page, content)) {
      const resolved = resolveStagedTarget(page, target);
      if (resolved.kind === 'skip') {
        skippedCount += 1;
        continue;
      }
      checkedCount += 1;
      if (resolved.kind === 'root-absolute') {
        broken.push({ page, lineNumber, target: target.trim(), reason: 'root-absolute' });
        continue;
      }

      // The file the site serves for this link: the named file when it is
      // staged, otherwise the directory index.
      const served =
        resolved.file !== '' && staged.has(resolved.file)
          ? resolved.file
          : staged.has(resolved.index)
            ? resolved.index
            : null;
      if (served === null) {
        broken.push({
          page,
          lineNumber,
          target: target.trim(),
          reason: 'missing',
          missing: resolved.file === '' ? resolved.index : resolved.file,
        });
        continue;
      }

      // A fragment must name an id or name in the served file. Only HTML can
      // be parsed for anchors; a fragment on any other file type is left alone.
      if (resolved.fragment !== '' && served.toLowerCase().endsWith('.html')) {
        if (!anchorResolves(await anchorsOf(served), resolved.fragment)) {
          broken.push({
            page,
            lineNumber,
            target: target.trim(),
            reason: 'missing anchor',
            missing: served,
            fragment: resolved.fragment,
          });
        }
      }
    }
  }

  return { pages, broken, checkedCount, skippedCount };
}

// Stage the allowlisted pages from sourceDir into a temporary directory and
// check the result. The temporary directory is removed afterward even on failure.
async function checkStagedSite(sourceDir = 'docs') {
  const stagedDir = await mkdtemp(join(tmpdir(), 'usabl-staged-links-'));
  try {
    const stagedFiles = await stagePublicPages(sourceDir, stagedDir);
    return await checkStagedLinks(stagedDir, stagedFiles);
  } finally {
    await rm(stagedDir, { recursive: true, force: true });
  }
}

function describeBroken(entry) {
  if (entry.reason === 'root-absolute') {
    return (
      `${entry.page}:${entry.lineNumber}: link "${entry.target}" is root-absolute and outside ` +
      `the site base path; the browser resolves it against the domain root, and this project ` +
      `Pages site is served under ${SITE_BASE_PATH}, so it returns 404 on the published site\n`
    );
  }
  if (entry.reason === 'missing anchor') {
    return (
      `${entry.page}:${entry.lineNumber}: link "${entry.target}" names anchor ` +
      `"#${entry.fragment}", and the staged "${entry.missing}" has no element with that id or name\n`
    );
  }
  return (
    `${entry.page}:${entry.lineNumber}: link "${entry.target}" points to "${entry.missing}", ` +
    'which is not in the staged Pages set and would return 404 on the published site\n'
  );
}

async function main() {
  const { pages, broken, checkedCount, skippedCount } = await checkStagedSite(process.argv[2]);

  for (const entry of broken) {
    process.stdout.write(describeBroken(entry));
  }

  process.stdout.write(
    `\nStaged ${pages.length} page(s): ${checkedCount} internal link(s) checked against the ` +
      `staged set, ${skippedCount} external link(s) skipped, ${broken.length} broken.\n`,
  );

  process.exit(broken.length > 0 ? 1 : 0);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `check-staged-links failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  });
}

export { checkStagedLinks, checkStagedSite, resolveStagedTarget };
