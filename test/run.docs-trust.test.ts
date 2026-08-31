import { describe, it, expect } from 'vitest';
import { run } from '../src/run.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import type { ScreenScan, UsablConfig } from '../src/contracts/index.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json', 'usabl.docs.json'],
};

const goodDocsManifest = JSON.stringify({
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

const evilDocsManifest = JSON.stringify({
  format: 'asciidoc-modular',
  docsBaseUrl: 'http://localhost:8080/docs',
  builtRoot: 'build/html',
  buildCommand: 'npm run build:docs',
  pages: [
    {
      pageId: 'evil',
      url: '/evil.html',
      assemblyFile: 'modules/evil.adoc',
      sources: ['modules/evil.adoc'],
    },
  ],
  sharedGlobs: ['modules/_attributes.adoc'],
});

const goodConfigJson = JSON.stringify(config);

describe('run with docs manifest trust overlay', () => {
  it('scans trusted-ref manifest when docs manifest diverged (explicit trustedRef)', async () => {
    // Working tree has attacker-chosen manifest (evil page), trusted ref has good manifest.
    // Config is identical in both so only usabl.docs.json diverges.
    const cleanGoodScan: ScreenScan = {
      screenId: 'getting-started',
      url: 'http://localhost:8080/docs/getting-started.html',
      stops: [],
      drafts: [],
      gaps: [],
    };

    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': goodConfigJson,
        'usabl.docs.json': evilDocsManifest,
      },
      headContents: {
        'usabl.config.json': goodConfigJson,
        'usabl.docs.json': goodDocsManifest,
      },
      refContents: {
        main: {
          'usabl.config.json': goodConfigJson,
          'usabl.docs.json': goodDocsManifest,
        },
      },
      changed: [],
      scans: { 'getting-started': cleanGoodScan },
    });

    const result = await run(deps, config, { trustedRef: 'main' });

    // Guard flagged divergence so verdict is approval_required with exit 2.
    expect(result.verdict).toBe('approval_required');
    expect(result.exitCode).toBe(2);

    // Scan targeted the TRUSTED page (getting-started from main), not the evil page from working tree.
    expect(result.coverage.affected).toHaveLength(1);
    const affectedScreen = result.coverage.affected[0];
    expect(affectedScreen).toEqual({
      screenId: 'getting-started',
      url: 'http://localhost:8080/docs/getting-started.html',
      provenance: 'docs-manifest',
      profile: 'docs',
    });

    // No screen with evil pageId was scanned.
    const hasEvil = result.coverage.affected.some((s) => s.screenId === 'evil');
    expect(hasEvil).toBe(false);
  });

  it('scans no docs when docs manifest diverged and no trustedRef available', async () => {
    // Working tree has evil manifest, HEAD has good manifest, so it diverges against HEAD default.
    // No trustedRef passed, so overlay returns null for usabl.docs.json.
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': goodConfigJson,
        'usabl.docs.json': evilDocsManifest,
      },
      headContents: {
        'usabl.config.json': goodConfigJson,
        'usabl.docs.json': goodDocsManifest,
      },
      changed: [],
      scans: {},
    });

    const result = await run(deps, config);

    // Guard flagged divergence so verdict is approval_required.
    expect(result.verdict).toBe('approval_required');
    expect(result.exitCode).toBe(2);

    // No docs-manifest screen was scanned because overlay returned null.
    const docsScreens = result.coverage.affected.filter((s) => s.provenance === 'docs-manifest');
    expect(docsScreens).toHaveLength(0);
  });
});
