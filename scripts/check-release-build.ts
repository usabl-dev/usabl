// Runs the release build check from scripts/release-build.ts and exits 1 with one plain line when
// dist/build-info.json would make `usabl install --ci` write the engine pin placeholder.
//
// Usage: vite-node scripts/check-release-build.ts [build record path]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RECORD, releaseBuildProblem } from './release-build.js';

function readRecord(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const problem = releaseBuildProblem(readRecord(resolve(process.argv[2] ?? RECORD)));
if (problem !== null) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
process.stdout.write(`usabl: ${RECORD} pins the engine to a clean commit, so the release can publish.\n`);
