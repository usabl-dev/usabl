/**
 * A workspace package folder comes from the disk, and the agent names it. Node's fs.glob has no
 * escape, so a folder name put into a pattern is read as a pattern: `pkg[1]` there means `pkg1`.
 * usabl lists the files under such a folder with the folder read as plain text, so its sources are
 * listed and an import in them is still found. These tests use a real temporary folder.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FsGlob, UsablConfig } from '../../src/contracts/index.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { packageSourceFiles } from '../../src/coverage/workspace-packages.js';
import { makeFsGlob } from '../../src/deps/fs.js';

// Every character Node reads as glob syntax in a name: a class, a brace group, a wildcard, and an
// extglob group.
const ODD = 'packages/pkg[1]{a,b}*?(x)';

const config: UsablConfig = {
  appBaseUrl: 'http://localhost:5173',
  uiFileGlobs: ['packages/admin/src/**/*.tsx'],
  discovery: { routerFile: 'packages/admin/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

const manifest = (name: string, dependencies: Record<string, string> = {}): string => JSON.stringify({ name, dependencies });

// The app declares the odd package. The odd package imports ui without declaring it, which
// hoisting lets resolve, so a change in ui may render in the app.
const TREE: Record<string, string> = {
  'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  'packages/admin/package.json': manifest('@mono/admin', { '@mono/odd': 'workspace:*' }),
  'packages/admin/src/App.tsx': 'export function App() { return null; }',
  [`${ODD}/package.json`]: manifest('@mono/odd'),
  [`${ODD}/src/index.ts`]: "export { Button } from '@mono/ui';",
  'packages/ui/package.json': manifest('@mono/ui'),
  'packages/ui/src/Button.tsx': 'export function Button() { return null; }',
  // A folder the odd name would match if it were read as a pattern.
  'packages/pkg1a/src/decoy.ts': 'export const decoy = 1;',
};

describe('a workspace package folder named with glob syntax', () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function disk(): Promise<FsGlob> {
    root = await mkdtemp(join(tmpdir(), 'usabl-ws-folder-'));
    for (const [file, text] of Object.entries(TREE)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    }
    return makeFsGlob({ cwd: root });
  }

  it('lists the sources under the folder and none from a folder its name would match', async () => {
    expect(await packageSourceFiles(await disk(), ODD)).toEqual([`${ODD}/src/index.ts`]);
  });

  it('still finds an undeclared import in the folder', async () => {
    const coverage = await computeCoverage(await disk(), config, ['packages/ui/src/Button.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
    expect(coverage.gaps[0]?.reason ?? '').toContain('@mono/ui in packages/ui');
  });

  it('counts the package as a link when a reader cannot list under a folder as text', async () => {
    const real = await disk();
    const plain: FsGlob = { readFile: (file) => real.readFile(file), glob: (patterns) => real.glob(patterns) };
    expect(await packageSourceFiles(plain, ODD)).toBeNull();
    const coverage = await computeCoverage(plain, config, ['packages/ui/src/Button.tsx']);
    expect(coverage.gaps.map((gap) => gap.ref)).toEqual(['packages/ui/src/Button.tsx']);
  });
});
