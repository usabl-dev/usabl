import { describe, it, expect } from 'vitest';
import { computeDocsCoverage } from '../../src/coverage/docs-planner.js';
import type { DocsManifest } from '../../src/coverage/docs-manifest.js';

describe('computeDocsCoverage', () => {
  it('returns empty array when manifest is null', () => {
    const result = computeDocsCoverage(null);
    expect(result).toEqual([]);
  });

  it('converts a two-page manifest to two AffectedScreen entries', () => {
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
          sources: ['modules/api-reference.adoc', 'modules/api-common.adoc'],
        },
      ],
      sharedGlobs: ['modules/_attributes.adoc'],
    };

    const result = computeDocsCoverage(manifest);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      screenId: 'getting-started',
      url: 'http://localhost:8080/docs/getting-started.html',
      provenance: 'docs-manifest',
      profile: 'docs',
    });
    expect(result[1]).toEqual({
      screenId: 'api-reference',
      url: 'http://localhost:8080/docs/api/reference.html',
      provenance: 'docs-manifest',
      profile: 'docs',
    });
  });

  it('joins page url correctly whether docsBaseUrl ends with slash or not', () => {
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

    const resultWith = computeDocsCoverage(withSlash);
    const resultWithout = computeDocsCoverage(withoutSlash);

    expect(resultWith[0]?.url).toBe('http://localhost:8080/docs/page1.html');
    expect(resultWithout[0]?.url).toBe('http://localhost:8080/docs/page1.html');
  });

  it('throws when a page url changes origin (protocol-relative attack)', () => {
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

    expect(() => computeDocsCoverage(manifest)).toThrow(/page url must stay under the docs base path/);
  });

  it('throws when a page url uses .. path traversal to escape base path', () => {
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

    expect(() => computeDocsCoverage(manifest)).toThrow(/page url must stay under the docs base path/);
  });

  it('throws when a page url uses backslash traversal to escape base path', () => {
    const manifest: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [
        {
          pageId: 'backslash',
          url: '/foo\\..\\..\\admin.html',
          assemblyFile: 'modules/backslash.adoc',
          sources: ['modules/backslash.adoc'],
        },
      ],
      sharedGlobs: [],
    };

    expect(() => computeDocsCoverage(manifest)).toThrow(/page url must stay under the docs base path/);
  });
});
