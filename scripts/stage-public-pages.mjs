import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The allowlist is the security boundary: only these files ever reach GitHub Pages.
// Paths are relative to the docs source and may be nested; the deck ships under demo/
// so its published URL is /usabl/demo/product-deck.html.
const PUBLIC_FILES = [
  'code-walkthrough.html',
  'demo/product-deck.html',
  'how-usabl-works.html',
  'team-orientation.html',
];
// The exact set the output directory must contain afterward, as sorted POSIX paths.
// index.html is a copy of team-orientation.html so the site root has a landing page.
const OUTPUT_FILES = [
  'code-walkthrough.html',
  'demo/product-deck.html',
  'how-usabl-works.html',
  'index.html',
  'team-orientation.html',
];

// Recursively list every regular file under dir as a sorted POSIX-relative path, so the
// equality assertion below covers nested staged files (the deck) and never a directory entry.
async function listStagedFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listStagedFiles(full, base)));
    } else {
      files.push(relative(base, full).split(sep).join('/'));
    }
  }
  return files.sort();
}

async function stagePublicPages(sourceDir = 'docs', outputDir = '.pages') {
  const source = resolve(sourceDir);
  const output = resolve(outputDir);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  for (const file of PUBLIC_FILES) {
    const input = resolve(source, file);
    const metadata = await lstat(input);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Public page must be a regular file: ${file}`);
    }
    const destination = resolve(output, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(input, destination);
  }
  await copyFile(resolve(source, 'team-orientation.html'), resolve(output, 'index.html'));

  const staged = await listStagedFiles(output);
  if (JSON.stringify(staged) !== JSON.stringify(OUTPUT_FILES)) {
    throw new Error(`Unexpected Pages artifact files: ${staged.join(', ')}`);
  }
  return staged;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  stagePublicPages(process.argv[2], process.argv[3]).then((files) => {
    process.stdout.write(`Staged public Pages files: ${files.join(', ')}\n`);
  });
}

// Exported so the staged link check can build the exact deploy artifact without
// carrying its own copy of the allowlist.
export { stagePublicPages };
