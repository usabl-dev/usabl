import { describe, it, expect } from 'vitest';
import type { FsGlob } from '../../src/contracts/index.js';
import { parseDocsManifest } from '../../src/coverage/docs-manifest.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

const fsOf = (files: Record<string, string>) => makeFakeDeps({ files }).fs;

const basePage = {
  pageId: 'install-guide',
  url: '/install-guide/index.html',
  assemblyFile: 'assemblies/assembly_install.adoc',
  sources: ['modules/con_overview.adoc', 'modules/proc_install.adoc'],
};

const validManifest = {
  format: 'asciidoc-modular',
  docsBaseUrl: 'http://127.0.0.1:0',
  builtRoot: 'build/html',
  buildCommand: 'make html',
  pages: [basePage],
  sharedGlobs: ['images/**', 'snippets/**'],
};

describe('parseDocsManifest', () => {
  it('parses a valid manifest into the expected typed object', async () => {
    const manifest = await parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(validManifest) }));
    expect(manifest).toEqual(validManifest);
  });

  it('returns null when the sidecar is absent', async () => {
    expect(await parseDocsManifest(fsOf({}))).toBeNull();
  });

  it('propagates a readFile IO error instead of treating it as no docs surface', async () => {
    const throwingFs: FsGlob = {
      readFile: async (_path: string) => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
      glob: async (_patterns: string[]) => [],
    };
    await expect(parseDocsManifest(throwingFs)).rejects.toThrow(/permission denied/i);
  });

  it('throws when the top-level value is an array rather than an object', async () => {
    await expect(
      parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify([validManifest]) })),
    ).rejects.toThrow(/must be an object/i);
  });

  it('throws when format is missing', async () => {
    const { format: _format, ...rest } = validManifest;
    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(rest) }))).rejects.toThrow(
      /usabl\.docs\.json format/i,
    );
  });

  it('throws when format is blank', async () => {
    await expect(
      parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify({ ...validManifest, format: '' }) })),
    ).rejects.toThrow(/usabl\.docs\.json format/i);
  });

  it('throws when docsBaseUrl is missing', async () => {
    const { docsBaseUrl: _docsBaseUrl, ...rest } = validManifest;
    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(rest) }))).rejects.toThrow(
      /usabl\.docs\.json docsBaseUrl/i,
    );
  });

  it('throws when a page url does not start with a slash', async () => {
    const bad = { ...validManifest, pages: [{ ...basePage, url: 'install-guide/index.html' }] };
    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(bad) }))).rejects.toThrow(/url/i);
  });

  it('throws when a page url contains @', async () => {
    const bad = { ...validManifest, pages: [{ ...basePage, url: '/@evil/index.html' }] };
    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(bad) }))).rejects.toThrow(/url/i);
  });

  it('throws when a page url contains lowercase percent-encoded dot traversal', async () => {
    const bad = { ...validManifest, pages: [{ ...basePage, url: '/%2e%2e/%2e%2e/admin.html' }] };
    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(bad) }))).rejects.toThrow(
      /percent-encoded path characters/i,
    );
  });

  it('throws when a page url contains uppercase percent-encoded dot traversal', async () => {
    const bad = { ...validManifest, pages: [{ ...basePage, url: '/%2E%2E/admin.html' }] };
    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(bad) }))).rejects.toThrow(
      /percent-encoded path characters/i,
    );
  });

  it('throws when a page url contains percent-encoded forward slash', async () => {
    const bad = { ...validManifest, pages: [{ ...basePage, url: '/a%2fb.html' }] };
    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(bad) }))).rejects.toThrow(
      /percent-encoded path characters/i,
    );
  });

  it('throws when a page url contains percent-encoded backslash', async () => {
    const bad = { ...validManifest, pages: [{ ...basePage, url: '/a%5cb.html' }] };
    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(bad) }))).rejects.toThrow(
      /percent-encoded path characters/i,
    );
  });

  it('accepts nested clean page urls without false positives', async () => {
    const clean = { ...validManifest, pages: [{ ...basePage, url: '/api/reference.html' }] };
    const manifest = await parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(clean) }));
    expect(manifest?.pages[0]?.url).toBe('/api/reference.html');
  });

  it('throws when builtRoot is an absolute path', async () => {
    await expect(
      parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify({ ...validManifest, builtRoot: '/etc/html' }) })),
    ).rejects.toThrow(/builtRoot/i);
  });

  it('throws when builtRoot escapes the repo with a .. segment', async () => {
    await expect(
      parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify({ ...validManifest, builtRoot: '../evil' }) })),
    ).rejects.toThrow(/builtRoot/i);
  });

  it('throws when an assemblyFile contains a .. segment', async () => {
    const bad = { ...validManifest, pages: [{ ...basePage, assemblyFile: 'assemblies/../../etc/passwd' }] };
    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(bad) }))).rejects.toThrow(/assemblyFile/i);
  });

  it('throws when a source path contains a .. segment', async () => {
    const bad = { ...validManifest, pages: [{ ...basePage, sources: ['modules/../../secret.adoc'] }] };
    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(bad) }))).rejects.toThrow(/sources/i);
  });

  it('refuses a pageId that carries the empty braille pattern, by position and code point', async () => {
    // pageId shares the screen id space with surfaces and routes, so it follows the shared id
    // grammar. The message names where the character is and never repeats the id.
    const bad = { ...validManifest, pages: [{ ...basePage, pageId: 'install\u2800guide' }] };

    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(bad) }))).rejects.toThrow(
      /pages\[0\]\.pageId contains a character that is not allowed, at position 8: U\+2800/,
    );
    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(bad) }))).rejects.not.toThrow(
      /\u2800/,
    );
  });

  it('refuses an empty pageId', async () => {
    const bad = { ...validManifest, pages: [{ ...basePage, pageId: '' }] };

    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(bad) }))).rejects.toThrow(
      /pages\[0\]\.pageId must be a non-empty string/,
    );
  });

  it('throws when two pages reuse a pageId', async () => {
    const bad = { ...validManifest, pages: [basePage, { ...basePage, url: '/other/index.html' }] };
    await expect(parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(bad) }))).rejects.toThrow(/pageId/i);
  });

  it('throws when pages is empty', async () => {
    await expect(
      parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify({ ...validManifest, pages: [] }) })),
    ).rejects.toThrow(/pages/i);
  });

  it('throws when buildCommand is present but not a string', async () => {
    await expect(
      parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify({ ...validManifest, buildCommand: 42 }) })),
    ).rejects.toThrow(/buildCommand/i);
  });

  it('defaults buildCommand to null when omitted', async () => {
    const { buildCommand: _buildCommand, ...rest } = validManifest;
    const manifest = await parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(rest) }));
    expect(manifest?.buildCommand).toBeNull();
  });

  it('accepts empty sources and empty sharedGlobs arrays', async () => {
    const minimal = { ...validManifest, pages: [{ ...basePage, sources: [] }], sharedGlobs: [] };
    const manifest = await parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify(minimal) }));
    expect(manifest?.pages[0]?.sources).toEqual([]);
    expect(manifest?.sharedGlobs).toEqual([]);
  });
});

describe('parseDocsManifest refuses a user name or password in docsBaseUrl', () => {
  // docsBaseUrl is joined into every docs screen url, and those urls reach every surface,
  // including a pull request comment. A user name or password written into it would be echoed
  // there. The refusal names the field and never the value, because the value is the secret.
  const messageFor = async (docsBaseUrl: string): Promise<string> => {
    try {
      await parseDocsManifest(fsOf({ 'usabl.docs.json': JSON.stringify({ ...validManifest, docsBaseUrl }) }));
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return '';
  };

  const refused: ReadonlyArray<readonly [string, string]> = [
    ['a user name and password', 'https://docuser:SECRETPOISON@docs.local/docs'],
    ['a user name alone', 'https://docuser@docs.local/docs'],
    ['an empty user name with a password', 'https://:SECRETPOISON@docs.local'],
    ['backslashes the URL parser reads as slashes', 'https:\\\\docuser:SECRETPOISON@docs.local'],
    ['an authority the URL parser refuses', 'http://docuser:SECRETPOISON@[docs/'],
    ['no scheme', 'docuser:SECRETPOISON@docs.local/docs'],
    // URL parsing reads this as a path, but a reader, or another parser that takes a backslash
    // for a slash, reads a user name and password in it.
    ['a backslash that reads as a second slash', 'foo:/\\docuser:SECRETPOISON@docs.local'],
  ];

  for (const [name, docsBaseUrl] of refused) {
    it(`refuses ${name} and never repeats the value`, async () => {
      const message = await messageFor(docsBaseUrl);

      expect(message).toContain('docsBaseUrl');
      expect(message).toMatch(/user name or password/);
      expect(message).not.toContain('SECRETPOISON');
      expect(message).not.toContain('docuser');
    });
  }

  it('accepts an "@" in the path, the query, or the fragment', async () => {
    for (const docsBaseUrl of [
      'http://127.0.0.1:0/docs/@scope',
      'http://127.0.0.1:0/docs?owner=@team',
      'http://127.0.0.1:0#@section',
    ]) {
      const manifest = await parseDocsManifest(
        fsOf({ 'usabl.docs.json': JSON.stringify({ ...validManifest, docsBaseUrl }) }),
      );
      expect(manifest?.docsBaseUrl).toBe(docsBaseUrl);
    }
  });
});
