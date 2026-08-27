import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_FILES = ['code-walkthrough.html', 'how-usabl-works.html', 'team-orientation.html'];
const OUTPUT_FILES = ['code-walkthrough.html', 'how-usabl-works.html', 'index.html', 'team-orientation.html'];

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
    await copyFile(input, resolve(output, file));
  }
  await copyFile(resolve(source, 'team-orientation.html'), resolve(output, 'index.html'));

  const staged = (await readdir(output)).sort();
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
