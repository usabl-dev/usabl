import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractLinks, EXTERNAL_PREFIX, splitLinkTarget } from './check-doc-links.mjs';
import { stagePublicPages } from './stage-public-pages.mjs';

// Link check over the published Pages artifact, not the source tree.
//
// The source-tree link check passes when a link target exists in the
// repository. The Pages deploy stages only an allowlist of files, so a page can
// link a file that exists in source and still 404 on the published site. This
// check stages the exact deploy artifact into a temporary directory, then
// requires every internal link in every staged HTML file to name a file that is
// itself in the staged set. Link extraction and target normalization are shared
// with the source-tree check so the two passes agree on what a link names.
//
// Resolution follows the browser. A relative link resolves against the linking
// page's directory. A directory reference (`.`, `./`, `demo/`, `demo`) is served
// as that directory's index.html. A root-absolute link (`/page.html`) resolves
// against the domain root, and this project site is served under a repository
// path, so such a link never reaches the site and is reported as broken. A link
// that climbs above the staged root is reported as missing. External URLs,
// data URIs, and same-page fragments are skipped; staging does not affect them.

// Published URL prefix for this project Pages site. Named only for the failure
// message; the staged tree has no mount point, so nothing is resolved against it.
const SITE_BASE_PATH = '/usabl/';

// Classify a link target written in one staged page.
//   { kind: 'skip' }                   not a file reference (external, data, fragment)
//   { kind: 'root-absolute' }          starts with `/`, never resolves under the site path
//   { kind: 'file', file, index }      candidate staged paths: the file itself (empty for a
//                                      directory reference) and that directory's index.html
function resolveStagedTarget(page, rawTarget) {
  const raw = rawTarget.trim();
  if (raw === '' || EXTERNAL_PREFIX.test(raw)) return { kind: 'skip' };

  const { path } = splitLinkTarget(raw);
  if (path === '') return { kind: 'skip' };
  if (path.startsWith('/')) return { kind: 'root-absolute' };

  // Normalize to a path relative to the staged root. posix.normalize keeps a
  // trailing slash and returns `.` or `./` for the root itself.
  let resolved = posix.normalize(posix.join(posix.dirname(page), path));
  if (resolved === '.') resolved = '';
  else if (resolved.startsWith('./')) resolved = resolved.slice(2);

  const isDirectory = resolved === '' || resolved.endsWith('/');
  const file = isDirectory ? '' : resolved;
  const index = isDirectory ? `${resolved}index.html` : `${resolved}/index.html`;
  return { kind: 'file', file, index };
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

  for (const page of pages) {
    const content = await readFile(resolve(stagedDir, page), 'utf8');
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
      if ((resolved.file !== '' && staged.has(resolved.file)) || staged.has(resolved.index)) {
        continue;
      }
      broken.push({
        page,
        lineNumber,
        target: target.trim(),
        reason: 'missing',
        missing: resolved.file === '' ? resolved.index : resolved.file,
      });
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
      `${entry.page}:${entry.lineNumber}: link "${entry.target}" is root-absolute; the browser ` +
      `resolves it against the domain root, and this project Pages site is served under ` +
      `${SITE_BASE_PATH}, so it returns 404 on the published site\n`
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
      `staged set, ${skippedCount} external or same-page link(s) skipped, ${broken.length} broken.\n`,
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
