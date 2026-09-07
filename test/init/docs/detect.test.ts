/**
 * Docs-onboarding detection and write behavior must be proven from in-memory
 * working trees, not from a checked-in usabl.docs.json. A wrong format guess or a
 * clobbered sidecar is a product failure, so detection precedence and the
 * refuse-to-overwrite guard are pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  DOCS_MANIFEST_PATH,
  formatDocsInitReport,
  inferDocsInit,
  writeDocsInitDraft,
  type DocsInitDraft,
  type DocsInitFs,
} from '../../../src/init/docs/index.js';
import { matchGlob } from '../../../src/primitives/match-glob.js';

function memoryFs(files: Record<string, string>): DocsInitFs & { store: Record<string, string> } {
  const store = { ...files };
  return {
    readFile: async (path) => store[path] ?? null,
    glob: async (patterns) => Object.keys(store).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async (path, contents) => {
      store[path] = contents;
    },
    store,
  };
}

const modularFixture: Record<string, string> = {
  'titles/aap/master.adoc': `= AAP Guide

include::../../assemblies/assembly_intro.adoc[leveloffset=+1]
`,
  'assemblies/assembly_intro.adoc': `[id="assembly_intro"]
= Intro

include::../modules/con_intro.adoc[leveloffset=+1]
`,
  'modules/con_intro.adoc': `[id="con_intro"]
= Intro concept

Some words.
`,
};

const asciibinderFixture: Record<string, string> = {
  '_topic_maps/_topic_map.yml': `---
Name: Guide
Dir: guide
Topics:
  - Name: Intro
    File: intro
`,
  'guide/intro.adoc': `= Intro

Some words.
`,
};

describe('inferDocsInit detection', () => {
  it('detects asciidoc-modular when a titles/*/master.adoc exists', async () => {
    const draft = await inferDocsInit(memoryFs(modularFixture));
    expect(draft).not.toBeNull();
    expect(draft?.manifest.format).toBe('asciidoc-modular');
  });

  it('detects asciibinder when a _topic_maps/_topic_map.yml exists', async () => {
    const draft = await inferDocsInit(memoryFs(asciibinderFixture));
    expect(draft).not.toBeNull();
    expect(draft?.manifest.format).toBe('asciibinder');
  });

  it('prefers asciidoc-modular when both markers exist', async () => {
    const draft = await inferDocsInit(memoryFs({ ...modularFixture, ...asciibinderFixture }));
    expect(draft?.manifest.format).toBe('asciidoc-modular');
  });

  it('returns null when no supported docs format is detected', async () => {
    const draft = await inferDocsInit(
      memoryFs({
        'antora.yml': 'name: docs\n',
        'mkdocs.yml': 'site_name: docs\n',
        'README.md': '# hello\n',
      }),
    );
    expect(draft).toBeNull();
  });
});

describe('writeDocsInitDraft', () => {
  async function draftOf(): Promise<{ fs: DocsInitFs & { store: Record<string, string> }; draft: DocsInitDraft }> {
    const fs = memoryFs(modularFixture);
    const draft = (await inferDocsInit(fs)) as DocsInitDraft;
    return { fs, draft };
  }

  it('writes usabl.docs.json when it is absent', async () => {
    const { fs, draft } = await draftOf();
    const result = await writeDocsInitDraft(fs, draft, { force: false });

    expect(result.ok).toBe(true);
    expect(result.written).toEqual([DOCS_MANIFEST_PATH]);
    expect(result.refused).toEqual([]);
    expect(fs.store[DOCS_MANIFEST_PATH]?.endsWith('\n')).toBe(true);
  });

  it('refuses to overwrite an existing sidecar without force and names --force', async () => {
    const { fs, draft } = await draftOf();
    fs.store[DOCS_MANIFEST_PATH] = '{"existing":true}';
    const result = await writeDocsInitDraft(fs, draft, { force: false });

    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(result.refused).toEqual([DOCS_MANIFEST_PATH]);
    expect(result.message).toContain('--force');
    expect(fs.store[DOCS_MANIFEST_PATH]).toBe('{"existing":true}');
  });

  it('overwrites an existing sidecar when force is true', async () => {
    const { fs, draft } = await draftOf();
    fs.store[DOCS_MANIFEST_PATH] = '{"existing":true}';
    const result = await writeDocsInitDraft(fs, draft, { force: true });

    expect(result.ok).toBe(true);
    expect(result.written).toEqual([DOCS_MANIFEST_PATH]);
    expect(fs.store[DOCS_MANIFEST_PATH]).not.toBe('{"existing":true}');
  });

  it('refuses to write a draft the sidecar parser would refuse, and says why without the id', async () => {
    // The adapters check every id where it is made. This is the boundary behind them: a draft
    // that reaches the write with an id the parser refuses is not written, so no future run can
    // fail on a file init left behind. The hostile character is named by position and code point.
    const { fs, draft } = await draftOf();
    const page = draft.manifest.pages[0];
    expect(page).toBeDefined();
    if (page === undefined) {
      return;
    }
    const hostile: DocsInitDraft = {
      ...draft,
      manifest: { ...draft.manifest, pages: [{ ...page, pageId: 'install\u2800guide' }] },
    };
    const result = await writeDocsInitDraft(fs, hostile, { force: false });

    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(fs.store[DOCS_MANIFEST_PATH]).toBeUndefined();
    expect(result.message).toContain('pages[0].pageId');
    expect(result.message).toContain('at position 8: U+2800');
    expect(result.message).not.toContain('\u2800');
  });
});

describe('formatDocsInitReport', () => {
  it('prints the result message then every note on its own line', async () => {
    const draft: DocsInitDraft = {
      manifest: {
        format: 'asciidoc-modular',
        docsBaseUrl: 'http://127.0.0.1:0',
        builtRoot: 'build',
        buildCommand: 'ccutil compile',
        pages: [
          { pageId: 'p', url: '/p/index.html', assemblyFile: 'a.adoc', sources: ['a.adoc'] },
        ],
        sharedGlobs: [],
      },
      notes: ['Review: first note.', 'Review: second note.'],
    };
    const report = formatDocsInitReport(draft, {
      ok: true,
      written: [DOCS_MANIFEST_PATH],
      refused: [],
      message: 'Wrote usabl.docs.json.',
    });

    expect(report).toBe('Wrote usabl.docs.json.\nReview: first note.\nReview: second note.\n');
  });
});
