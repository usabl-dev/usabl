import { describe, it, expect, vi } from 'vitest';
import { run } from '../src/run.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import type { Draft, ScreenScan, UsablConfig } from '../src/contracts/index.js';

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

const guardOk = {
  files: { 'usabl.config.json': '{}', 'usabl.docs.json': docsManifest },
  headContents: { 'usabl.config.json': '{}', 'usabl.docs.json': docsManifest },
};

describe('run with docs manifest', () => {
  it('produces regression verdict when docs manifest page has a failing draft', async () => {
    const failingDocsDraft: Draft = {
      rule: 'docs-heading-order',
      layer: 'docs-content',
      severity: 'serious',
      evidenceClass: 'deterministic',
      screenId: 'getting-started',
      elementPath: 'h3',
      elementName: 'Installation',
      role: 'heading',
      whatUserExperiences: 'Heading hierarchy is broken',
      why: 'h3 follows h1 with no h2',
      fix: 'Insert h2 or demote this heading',
      evidence: { name: { value: 'Installation', source: 'attribute', fromTree: false } },
      confidence: 'fail',
    };

    const scanWithDocsDraft: ScreenScan = {
      screenId: 'getting-started',
      url: 'http://localhost:8080/docs/getting-started.html',
      stops: [],
      drafts: [failingDocsDraft],
      gaps: [],
    };

    const deps = makeFakeDeps({
      ...guardOk,
      changed: [],
      scans: { 'getting-started': scanWithDocsDraft },
    });

    const scanSpy = vi.spyOn(deps.checkRunner, 'scan');

    const result = await run(deps, config);

    expect(result.verdict).toBe('regression');
    expect(result.exitCode).toBe(1);
    expect(result.accessibilityVerdict).toBe('regression');
    expect(result.accessibilityExitCode).toBe(1);
    expect(result.coverage.affected).toHaveLength(1);
    expect(result.coverage.affected[0]).toEqual({
      screenId: 'getting-started',
      url: 'http://localhost:8080/docs/getting-started.html',
      provenance: 'docs-manifest',
      profile: 'docs',
    });

    expect(scanSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'getting-started',
        profile: 'docs',
      })
    );
  });

  it('produces verified verdict when docs manifest page is clean', async () => {
    const cleanDocsScan: ScreenScan = {
      screenId: 'getting-started',
      url: 'http://localhost:8080/docs/getting-started.html',
      stops: [],
      drafts: [],
      gaps: [],
    };

    const deps = makeFakeDeps({
      ...guardOk,
      writeTree: 'tree-docs-1',
      changed: [],
      scans: { 'getting-started': cleanDocsScan },
    });

    const result = await run(deps, config);

    expect(result.verdict).toBe('verified');
    expect(result.exitCode).toBe(0);
    expect(result.coverage.nothingToCheck).toBe(false);
    expect(result.receipt?.coverage.checked).toContain('getting-started');
  });

  it('is idle when no manifest and no UI changes (app path byte-identical)', async () => {
    const deps = makeFakeDeps({
      files: { 'usabl.config.json': '{}' },
      headContents: { 'usabl.config.json': '{}' },
      changed: [],
    });

    const result = await run(deps, config);

    expect(result.verdict).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.coverage.nothingToCheck).toBe(true);
  });
});
