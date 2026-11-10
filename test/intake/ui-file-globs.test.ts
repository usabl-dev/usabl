/**
 * A config with an empty uiFileGlobs list reads no change as a UI change, so every run would say
 * nothing to check and exit 0 without looking at anything. One rule decides when such a config is
 * refused, and every path that reads a config uses it. The one shape that loads is a
 * documentation-only repository whose usabl.docs.json loads and names at least one page.
 */
import { describe, expect, it } from 'vitest';
import { docsManifestNamesAPage, emptyUiFileGlobsRefusal, uiFileGlobsRefusal } from '../../src/intake/ui-file-globs.js';

const manifest = (pages: unknown[]): string =>
  JSON.stringify({
    format: 'asciidoc-modular',
    docsBaseUrl: 'http://127.0.0.1:4000',
    builtRoot: 'build/html',
    pages,
    sharedGlobs: [],
  });

const page = {
  pageId: 'install-guide',
  url: '/install-guide/index.html',
  assemblyFile: 'assemblies/assembly_install.adoc',
  sources: ['modules/proc_install.adoc'],
};

describe('uiFileGlobsRefusal', () => {
  it('lets a config with UI globs through without reading the docs manifest', () => {
    expect(uiFileGlobsRefusal({ uiFileGlobs: ['src/**/*.tsx'] }, null, 'usabl.config.json')).toBeNull();
  });

  it('lets an empty list through only when the docs manifest loads and names a page', () => {
    expect(uiFileGlobsRefusal({ uiFileGlobs: [] }, manifest([page]), 'usabl.config.json')).toBeNull();
  });

  it('refuses an empty list with no docs manifest, an empty one, or one that does not load', () => {
    for (const docs of [null, manifest([]), '{"docsBaseUrl":"http://127.0.0.1:4000","pages":[]}', '{not json', manifest([{ pageId: '' }])]) {
      expect(uiFileGlobsRefusal({ uiFileGlobs: [] }, docs, 'usabl.config.json')).toBe(emptyUiFileGlobsRefusal('usabl.config.json'));
    }
  });

  it('says what happened, that usabl did not run, and what to put in the list', () => {
    const text = emptyUiFileGlobsRefusal('usabl.config.json');
    expect(text).toContain('usabl.config.json has an empty uiFileGlobs list');
    expect(text).toContain('usabl did not run');
    expect(text).toContain('src/**/*.tsx');
    expect(text).toContain('a usabl.docs.json that loads and names at least one page');
  });

  it('reads a manifest as naming a page only when it loads', () => {
    expect(docsManifestNamesAPage(manifest([page]))).toBe(true);
    expect(docsManifestNamesAPage(manifest([]))).toBe(false);
    expect(docsManifestNamesAPage(null)).toBe(false);
  });
});
