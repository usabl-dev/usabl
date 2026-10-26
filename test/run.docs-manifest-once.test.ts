import { describe, expect, it, vi } from 'vitest';
import type { ScreenScan, UsablConfig } from '../src/contracts/index.js';

// The real parser runs. The spy only counts how often a run asks for it, because the guard also
// reads usabl.docs.json to compare bytes, so a count of file reads cannot tell a parse apart.
vi.mock('../src/coverage/docs-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/coverage/docs-manifest.js')>();
  return { ...actual, parseDocsManifest: vi.fn(actual.parseDocsManifest) };
});

const { parseDocsManifest } = await import('../src/coverage/docs-manifest.js');
const { run } = await import('../src/run.js');
const { makeFakeDeps } = await import('../src/deps/fakes.js');

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json', 'usabl.docs.json'],
};

const docsManifest = JSON.stringify({
  format: 'asciidoc-modular',
  docsBaseUrl: 'http://localhost:8080/docs',
  builtRoot: 'build/html',
  buildCommand: 'npm run build:docs',
  pages: [
    {
      pageId: 'getting-started',
      url: '/getting-started.html',
      assemblyFile: 'modules/getting-started.adoc',
      sources: ['modules/getting-started.adoc'],
    },
  ],
  sharedGlobs: ['modules/_attributes.adoc'],
});

const cleanDocsScan: ScreenScan = {
  screenId: 'getting-started',
  url: 'http://localhost:8080/docs/getting-started.html',
  stops: [],
  drafts: [],
  gaps: [],
  applicability: [],
  reachedSelectorPresent: null,
};

describe('run reads the docs manifest once', () => {
  it('parses usabl.docs.json once and plans and checks screen ids from that one parse', async () => {
    const deps = makeFakeDeps({
      files: { 'usabl.config.json': '{}', 'usabl.docs.json': docsManifest },
      headContents: { 'usabl.config.json': '{}', 'usabl.docs.json': docsManifest },
      changed: [{ code: 'M', path: 'modules/getting-started.adoc' }],
      scans: { 'getting-started': cleanDocsScan },
    });
    vi.mocked(parseDocsManifest).mockClear();

    const result = await run(deps, config);

    expect(result.verdict).toBe('verified');
    expect(result.coverage.affected.map((screen) => screen.screenId)).toEqual(['getting-started']);
    expect(vi.mocked(parseDocsManifest)).toHaveBeenCalledTimes(1);
  });
});
