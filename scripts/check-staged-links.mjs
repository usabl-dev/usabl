import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractLinks, EXTERNAL_PREFIX } from './check-doc-links.mjs';
import { stagePublicPages } from './stage-public-pages.mjs';

// Link check over the published Pages artifact, not the source tree.
//
// The source-tree link check passes when a link target exists in the
// repository. The Pages deploy stages only an allowlist of files, so a page can
// link a file that exists in source and still 404 on the published site. This
// check stages the exact deploy artifact into a temporary directory, then
// requires every internal href and src in every staged HTML file to resolve to
// a file that is itself in the staged set. External URLs, data URIs, and pure
// fragments are skipped; they are not affected by staging.

// Resolve a link target written in one staged page to a staged-set path.
// Returns the POSIX path relative to the staged root, or null when the link is
// not a file reference (external, data, or a pure fragment on the same page).
function resolveStagedTarget(page, rawTarget) {
  const raw = rawTarget.trim();
  if (raw === '' || EXTERNAL_PREFIX.test(raw)) return null;

  // Drop the fragment and query; neither changes which file is served.
  const withoutFragment = raw.split('#')[0];
  const pathPart = withoutFragment.split('?')[0];
  if (pathPart === '') return null;

  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    // Keep the raw form; a malformed escape still names a path to look up.
  }

  // Resolve relative to the page's own directory inside the staged tree. A
  // root-absolute or parent-escaping path normalizes to something outside the
  // staged set and is reported as missing, which is what it would be on the site.
  const resolved = posix.normalize(posix.join(posix.dirname(page), decoded));
  return resolved;
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
      if (resolved === null) {
        skippedCount += 1;
        continue;
      }
      checkedCount += 1;
      // A directory-style link is served as that directory's index.html.
      const asIndex = resolved.endsWith('/') ? `${resolved}index.html` : `${resolved}/index.html`;
      if (staged.has(resolved) || staged.has(asIndex)) continue;
      broken.push({ page, lineNumber, target: target.trim(), missing: resolved });
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

async function main() {
  const { pages, broken, checkedCount, skippedCount } = await checkStagedSite(process.argv[2]);

  for (const entry of broken) {
    process.stdout.write(
      `${entry.page}:${entry.lineNumber}: link "${entry.target}" points to "${entry.missing}", ` +
        'which is not in the staged Pages set and would return 404 on the published site\n',
    );
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
