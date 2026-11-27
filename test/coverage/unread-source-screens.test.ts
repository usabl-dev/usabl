/**
 * A file past the import reader's size caps is not read for imports, so it may load any file. A
 * screen whose import closure holds such a file therefore reaches every changed UI file, and is
 * planned for each one. Before this, the screen was planned only for the files it reached by
 * the imports usabl did read, so a shared component that the screen loads through the big file
 * was checked on another screen alone, with no gap.
 */
import { describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { MAX_SOURCE_CHARACTERS, MAX_SOURCE_LINE_CHARACTERS } from '../../src/coverage/import-graph.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

const BASE = 'http://127.0.0.1:5173';
const ROUTER =
  "import { Route, Routes } from 'react-router-dom';\n" +
  "import { XPage } from './XPage';\nimport { YPage } from './YPage';\n" +
  'export function App() { return (<Routes><Route path="/x" element={<XPage />} /><Route path="/y" element={<YPage />} /></Routes>); }\n';

const config: UsablConfig = {
  appBaseUrl: BASE,
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: [],
} as unknown as UsablConfig;

// One comment line past the line cap, or short lines that add up past the file cap.
const FILLERS = {
  line: `// ${'a'.repeat(MAX_SOURCE_LINE_CHARACTERS + 1)}\n`,
  size: `// ${'a'.repeat(1_000)}\n`.repeat(Math.ceil(MAX_SOURCE_CHARACTERS / 1_000) + 1),
};

function files(filler: string): Record<string, string> {
  return {
    'usabl.routes.json':
      JSON.stringify({
        routes: [
          { screenId: 'x', url: '/x', entryFile: 'src/XPage.tsx' },
          { screenId: 'y', url: '/y', entryFile: 'src/YPage.tsx' },
        ],
      }) + '\n',
    'src/App.tsx': ROUTER,
    'src/XPage.tsx': "import { Button } from './Button';\nexport const XPage = () => Button;\n",
    'src/YPage.tsx': "import { Big } from './Big';\nexport const YPage = () => Big;\n",
    'src/Big.tsx':
      "import { Button } from './Button';\nimport { Only } from './OnlyY';\nexport const Big = () => [Button, Only];\n" + filler,
    'src/Button.tsx': 'export const Button = 2;\n',
    'src/OnlyY.tsx': 'export const Only = 2;\n',
    'src/Orphan.tsx': 'export const Orphan = 2;\n',
  };
}

describe.each(Object.entries(FILLERS))('a screen whose closure holds a file past the %s cap', (_mode, filler) => {
  const fs = makeFakeDeps({ files: files(filler) }).fs;

  it('is planned for a changed file another screen imports, with the unread file in the chain', async () => {
    const coverage = await computeCoverage(fs, config, ['src/Button.tsx']);

    expect(coverage.affected.map((screen) => screen.screenId).sort()).toEqual(['x', 'y']);
    const y = coverage.affected.find((screen) => screen.screenId === 'y');
    expect(y?.importChain).toEqual(['src/YPage.tsx', 'src/Big.tsx', 'src/Button.tsx']);
    expect(y?.reason).toContain('src/Big.tsx was not read for imports');
    expect(coverage.gaps).toEqual([]);
  });

  it('is planned for a changed file only the unread file imports', async () => {
    const coverage = await computeCoverage(fs, config, ['src/OnlyY.tsx']);

    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['y']);
    expect(coverage.unresolvedFiles).toEqual([]);
    expect(coverage.gaps).toEqual([]);
  });

  it('is planned for a changed file that no import usabl read reaches', async () => {
    const coverage = await computeCoverage(fs, config, ['src/Orphan.tsx']);

    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['y']);
    expect(coverage.gaps).toEqual([]);
  });
});

describe('screens with no unread file on their path', () => {
  it('are planned as before: only for the files their imports reach', async () => {
    const fs = makeFakeDeps({ files: files('') }).fs;

    const button = await computeCoverage(fs, config, ['src/Button.tsx']);
    expect(button.affected.map((screen) => screen.screenId).sort()).toEqual(['x', 'y']);
    const onlyY = await computeCoverage(fs, config, ['src/OnlyY.tsx']);
    expect(onlyY.affected.map((screen) => screen.screenId)).toEqual(['y']);
    const orphan = await computeCoverage(fs, config, ['src/Orphan.tsx']);
    expect(orphan.affected).toEqual([]);
    expect(orphan.unresolvedFiles).toEqual(['src/Orphan.tsx']);
  });
});
