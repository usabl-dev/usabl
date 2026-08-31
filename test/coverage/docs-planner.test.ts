import { describe, it, expect } from 'vitest';
import { computeDocsCoverage } from '../../src/coverage/docs-planner.js';
import type { DocsManifest } from '../../src/coverage/docs-manifest.js';

describe('computeDocsCoverage', () => {
  it('returns empty result when manifest is null', () => {
    const result = computeDocsCoverage(null, []);
    expect(result).toEqual({
      affected: [],
      unresolvedFiles: [],
      gaps: [],
      nothingToCheck: true,
    });
  });

  it('returns nothingToCheck when manifest present but no doc files changed', () => {
    const manifest: DocsManifest = {
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
    };

    const result = computeDocsCoverage(manifest, ['src/app/Foo.tsx', 'README.md']);
    expect(result).toEqual({
      affected: [],
      unresolvedFiles: [],
      gaps: [],
      nothingToCheck: true,
    });
  });

  it('maps a changed module to only the pages that include it', () => {
    const manifest: DocsManifest = {
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
        {
          pageId: 'api-reference',
          url: '/api/reference.html',
          assemblyFile: 'modules/api-reference.adoc',
          sources: ['modules/api-reference.adoc'],
        },
      ],
      sharedGlobs: [],
    };

    const result = computeDocsCoverage(manifest, ['modules/getting-started.adoc']);
    expect(result.nothingToCheck).toBe(false);
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0]).toEqual({
      screenId: 'getting-started',
      url: 'http://localhost:8080/docs/getting-started.html',
      provenance: 'docs-manifest',
      profile: 'docs',
    });
    expect(result.unresolvedFiles).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it('maps a source shared by two pages to both pages', () => {
    const manifest: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [
        {
          pageId: 'page-a',
          url: '/page-a.html',
          assemblyFile: 'modules/page-a.adoc',
          sources: ['modules/page-a.adoc', 'modules/common.adoc'],
        },
        {
          pageId: 'page-b',
          url: '/page-b.html',
          assemblyFile: 'modules/page-b.adoc',
          sources: ['modules/page-b.adoc', 'modules/common.adoc'],
        },
      ],
      sharedGlobs: [],
    };

    const result = computeDocsCoverage(manifest, ['modules/common.adoc']);
    expect(result.nothingToCheck).toBe(false);
    expect(result.affected).toHaveLength(2);
    expect(result.affected.map((s) => s.screenId).sort()).toEqual(['page-a', 'page-b']);
    expect(result.affected.every((s) => s.provenance === 'docs-manifest')).toBe(true);
    expect(result.unresolvedFiles).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it('triggers wide blast when a changed sharedGlobs .adoc file matches', () => {
    const manifest: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [
        {
          pageId: 'page-1',
          url: '/page-1.html',
          assemblyFile: 'modules/page-1.adoc',
          sources: ['modules/page-1.adoc'],
        },
        {
          pageId: 'page-2',
          url: '/page-2.html',
          assemblyFile: 'modules/page-2.adoc',
          sources: ['modules/page-2.adoc'],
        },
      ],
      sharedGlobs: ['attributes/**'],
    };

    const result = computeDocsCoverage(manifest, ['attributes/common.adoc']);
    expect(result.nothingToCheck).toBe(false);
    expect(result.affected).toHaveLength(2);
    expect(result.affected.every((s) => s.provenance === 'wide-blast')).toBe(true);
    expect(result.unresolvedFiles).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it('triggers wide blast when a changed sharedGlobs non-.adoc file matches', () => {
    const manifest: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [
        {
          pageId: 'page-1',
          url: '/page-1.html',
          assemblyFile: 'modules/page-1.adoc',
          sources: ['modules/page-1.adoc'],
        },
      ],
      sharedGlobs: ['images/**'],
    };

    const result = computeDocsCoverage(manifest, ['images/logo.png']);
    expect(result.nothingToCheck).toBe(false);
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0]?.provenance).toBe('wide-blast');
    expect(result.unresolvedFiles).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it('produces a gap when a changed .adoc is unmapped', () => {
    const manifest: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [
        {
          pageId: 'getting-started',
          url: '/getting-started.html',
          assemblyFile: 'modules/getting-started.adoc',
          sources: ['modules/getting-started.adoc'],
        },
      ],
      sharedGlobs: ['modules/_attributes.adoc'],
    };

    const result = computeDocsCoverage(manifest, ['modules/orphan.adoc']);
    expect(result.nothingToCheck).toBe(false);
    expect(result.affected).toEqual([]);
    expect(result.unresolvedFiles).toEqual(['modules/orphan.adoc']);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      ref: 'modules/orphan.adoc',
      state: 'unresolved',
    });
    expect(result.gaps[0]?.reason).toContain('not in any page sources or shared glob pattern');
  });

  it('keeps the orphan .adoc gap even when a wide blast scans every page', () => {
    const manifest: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [
        {
          pageId: 'page-1',
          url: '/page-1.html',
          assemblyFile: 'modules/page-1.adoc',
          sources: ['modules/page-1.adoc'],
        },
        {
          pageId: 'page-2',
          url: '/page-2.html',
          assemblyFile: 'modules/page-2.adoc',
          sources: ['modules/page-2.adoc'],
        },
      ],
      sharedGlobs: ['modules/_attributes.adoc'],
    };

    const result = computeDocsCoverage(manifest, ['modules/_attributes.adoc', 'modules/orphan.adoc']);
    expect(result.nothingToCheck).toBe(false);
    // Wide blast queued every page for scanning, so scan reach is total.
    expect(result.affected).toHaveLength(2);
    expect(result.affected.map((s) => s.screenId).sort()).toEqual(['page-1', 'page-2']);
    expect(result.affected.every((s) => s.provenance === 'wide-blast')).toBe(true);
    // Scanning every page is not the same as covering every change: the orphan .adoc
    // maps to no page source, so it must still be an explicit gap. Fail-closed wins.
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      ref: 'modules/orphan.adoc',
      state: 'unresolved',
    });
    expect(result.unresolvedFiles).toEqual(['modules/orphan.adoc']);
  });

  it('records both a mapped page and an orphan .adoc gap for partial coverage', () => {
    const manifest: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [
        {
          pageId: 'getting-started',
          url: '/getting-started.html',
          assemblyFile: 'modules/getting-started.adoc',
          sources: ['modules/getting-started.adoc'],
        },
        {
          pageId: 'api-reference',
          url: '/api/reference.html',
          assemblyFile: 'modules/api-reference.adoc',
          sources: ['modules/api-reference.adoc'],
        },
      ],
      sharedGlobs: [],
    };

    const result = computeDocsCoverage(manifest, ['modules/getting-started.adoc', 'modules/orphan.adoc']);
    expect(result.nothingToCheck).toBe(false);
    // The mapped module attributes exactly its own page via the docs manifest.
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0]).toEqual({
      screenId: 'getting-started',
      url: 'http://localhost:8080/docs/getting-started.html',
      provenance: 'docs-manifest',
      profile: 'docs',
    });
    // Partial coverage still leaves the orphan .adoc as an explicit gap.
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      ref: 'modules/orphan.adoc',
      state: 'unresolved',
    });
    expect(result.unresolvedFiles).toEqual(['modules/orphan.adoc']);
  });

  it('ignores non-doc non-shared changed files', () => {
    const manifest: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [
        {
          pageId: 'page-1',
          url: '/page-1.html',
          assemblyFile: 'modules/page-1.adoc',
          sources: ['modules/page-1.adoc'],
        },
      ],
      sharedGlobs: [],
    };

    const result = computeDocsCoverage(manifest, ['README.md', 'src/app.ts']);
    expect(result).toEqual({
      affected: [],
      unresolvedFiles: [],
      gaps: [],
      nothingToCheck: true,
    });
  });

  it('preserves URL building for affected pages with and without trailing slash', () => {
    const withSlash: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs/',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [
        {
          pageId: 'page1',
          url: '/page1.html',
          assemblyFile: 'modules/page1.adoc',
          sources: ['modules/page1.adoc'],
        },
      ],
      sharedGlobs: [],
    };

    const withoutSlash: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [
        {
          pageId: 'page1',
          url: '/page1.html',
          assemblyFile: 'modules/page1.adoc',
          sources: ['modules/page1.adoc'],
        },
      ],
      sharedGlobs: [],
    };

    const resultWith = computeDocsCoverage(withSlash, ['modules/page1.adoc']);
    const resultWithout = computeDocsCoverage(withoutSlash, ['modules/page1.adoc']);

    expect(resultWith.affected[0]?.url).toBe('http://localhost:8080/docs/page1.html');
    expect(resultWithout.affected[0]?.url).toBe('http://localhost:8080/docs/page1.html');
  });

  it('throws when a page url escapes base path via traversal', () => {
    const manifest: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [
        {
          pageId: 'traversal',
          url: '/../../../admin/secrets.html',
          assemblyFile: 'modules/traversal.adoc',
          sources: ['modules/traversal.adoc'],
        },
      ],
      sharedGlobs: [],
    };

    expect(() => computeDocsCoverage(manifest, ['modules/traversal.adoc'])).toThrow(
      /page url must stay under the docs base path/,
    );
  });

  it('throws when a page url changes origin via protocol-relative url', () => {
    const manifest: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [
        {
          pageId: 'evil',
          url: '//evil.com/phish.html',
          assemblyFile: 'modules/evil.adoc',
          sources: ['modules/evil.adoc'],
        },
      ],
      sharedGlobs: [],
    };

    expect(() => computeDocsCoverage(manifest, ['modules/evil.adoc'])).toThrow(
      /page url must stay under the docs base path/,
    );
  });
});
