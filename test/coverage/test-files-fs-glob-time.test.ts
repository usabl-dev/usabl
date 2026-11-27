/**
 * Test-file placement lists uiFileGlobs with the file system adapter's glob. A committed entry with
 * many wildcards and a file with a long name must not make that listing slow, or a Stop hook could
 * outlast the host's limit with nothing checked. This test uses a real temporary folder and the
 * real adapter.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFsGlob } from '../../src/deps/fs.js';

// `src/`, then `*a` twelve times, then `*b`. Node took seconds on one name of 30 letters, and
// about five times as long for each four letters more. The test name has 34.
const SLOW_GLOB = `src/${'*a'.repeat(12)}*b`;
// Far above the time placement takes here, so a loaded machine does not fail the test.
const QUICK_MS = 3000;

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: [SLOW_GLOB, 'src/**/*.tsx'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

describe('test-file placement with many wildcards in uiFileGlobs', { timeout: 120_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('places a changed test file quickly next to a long file name', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-placement-fs-glob-'));
    const files: Record<string, string> = {
      'src/App.tsx': 'export function App() { return null; }\n',
      'src/__tests__/App.test.tsx': "import { App } from '../App';\nexport const x = App;\n",
      [`src/${'a'.repeat(34)}`]: '',
    };
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    }
    const start = performance.now();
    const coverage = await computeCoverage(makeFsGlob({ cwd: root }), config, ['src/__tests__/App.test.tsx']);
    const ms = performance.now() - start;
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual(['src/__tests__/App.test.tsx']);
    expect(ms).toBeLessThan(QUICK_MS);
  });
});
