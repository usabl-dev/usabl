/**
 * The Pantheon adapter turns guide masters into a draft docs manifest. It must
 * read the anchor an author wrote, follow the real include closure for each
 * assembly, and never emit a manifest that the sidecar parser would reject. The
 * round-trip through parseDocsManifest is the contract these tests hold.
 */
import { describe, expect, it } from 'vitest';
import { inferAsciidocModular } from '../../../src/init/docs/asciidoc-modular.js';
import { parseDocsManifest } from '../../../src/coverage/docs-manifest.js';
import { computeDocsCoverage } from '../../../src/coverage/docs-planner.js';
import { DOCS_MANIFEST_PATH, writeDocsInitDraft, type DocsInitFs } from '../../../src/init/docs/index.js';
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

async function roundTrips(json: string): Promise<boolean> {
  const fs = memoryFs({ 'usabl.docs.json': json });
  await parseDocsManifest(fs);
  return true;
}

describe('inferAsciidocModular', () => {
  it('maps each assembly to a page with its anchor id, include closure, and a rooted url', async () => {
    const fs = memoryFs({
      'titles/aap/master.adoc': `= AAP Guide

include::../../assemblies/assembly_configuring.adoc[leveloffset=+1]
`,
      'assemblies/assembly_configuring.adoc': `[id="assembly_configuring-clusters"]
= Configuring clusters

include::../modules/con_clusters.adoc[leveloffset=+1]
include::../modules/proc_configuring.adoc[leveloffset=+1]
`,
      'modules/con_clusters.adoc': `[id="con_clusters"]
= Clusters concept

Words.
`,
      'modules/proc_configuring.adoc': `[id="proc_configuring"]
= Configuring procedure

Words.
`,
    });

    const draft = await inferAsciidocModular(fs);

    expect(draft.manifest.format).toBe('asciidoc-modular');
    expect(draft.manifest.builtRoot).toBe('build');
    expect(draft.manifest.buildCommand).toBe('ccutil compile');
    expect(draft.manifest.docsBaseUrl).toBe('http://127.0.0.1:0');
    expect(draft.manifest.pages).toHaveLength(1);

    const page = draft.manifest.pages[0];
    expect(page?.pageId).toBe('assembly_configuring-clusters');
    expect(page?.assemblyFile).toBe('assemblies/assembly_configuring.adoc');
    expect(page?.sources).toContain('assemblies/assembly_configuring.adoc');
    expect(page?.sources).toContain('modules/con_clusters.adoc');
    expect(page?.sources).toContain('modules/proc_configuring.adoc');
    expect(page?.url.startsWith('/')).toBe(true);

    // The whole manifest must survive the sidecar parser without throwing.
    expect(await roundTrips(JSON.stringify(draft.manifest))).toBe(true);
  });

  it('recognizes the [#value] and [[value]] anchor forms', async () => {
    const fs = memoryFs({
      'titles/aap/master.adoc': `= AAP

include::../../assemblies/assembly_short.adoc[]
include::../../assemblies/assembly_legacy.adoc[]
`,
      'assemblies/assembly_short.adoc': `[#assembly_short-id]
= Short form
`,
      'assemblies/assembly_legacy.adoc': `[[assembly_legacy-id]]
= Legacy form
`,
    });

    const draft = await inferAsciidocModular(fs);
    const ids = draft.manifest.pages.map((p) => p.pageId);
    expect(ids).toContain('assembly_short-id');
    expect(ids).toContain('assembly_legacy-id');
  });

  it('guesses a pageId from the filename and warns loudly when no anchor is present', async () => {
    const fs = memoryFs({
      'titles/aap/master.adoc': `= AAP

include::../../assemblies/assembly_noanchor.adoc[leveloffset=+1]
`,
      'assemblies/assembly_noanchor.adoc': `= No anchor here

Just a title.
`,
    });

    const draft = await inferAsciidocModular(fs);
    expect(draft.manifest.pages[0]?.pageId).toBe('assembly-noanchor');
    expect(
      draft.notes.some(
        (n) => n.toLowerCase().includes('review') && n.includes('assembly_noanchor.adoc'),
      ),
    ).toBe(true);
    expect(await roundTrips(JSON.stringify(draft.manifest))).toBe(true);
  });

  it('suffixes a duplicate pageId and warns instead of emitting a rejected manifest', async () => {
    const fs = memoryFs({
      'titles/aap/master.adoc': `= AAP

include::../../assemblies/assembly_a.adoc[]
include::../../assemblies/assembly_b.adoc[]
`,
      'assemblies/assembly_a.adoc': `[id="dup"]
= A
`,
      'assemblies/assembly_b.adoc': `[id="dup"]
= B
`,
    });

    const draft = await inferAsciidocModular(fs);
    const ids = draft.manifest.pages.map((p) => p.pageId);
    expect(ids).toEqual(['dup', 'dup-2']);
    expect(draft.notes.some((n) => n.toLowerCase().includes('review') && n.includes('dup'))).toBe(true);
    expect(await roundTrips(JSON.stringify(draft.manifest))).toBe(true);
  });

  it('surfaces an unresolved include as a review note without dropping the page', async () => {
    const fs = memoryFs({
      'titles/aap/master.adoc': `= AAP

include::../../assemblies/assembly_gap.adoc[]
`,
      'assemblies/assembly_gap.adoc': `[id="assembly_gap"]
= Has a gap

include::../modules/con_missing.adoc[leveloffset=+1]
`,
    });

    const draft = await inferAsciidocModular(fs);
    expect(draft.manifest.pages).toHaveLength(1);
    expect(draft.notes.some((n) => n.toLowerCase().includes('review') && n.includes('con_missing.adoc'))).toBe(true);
    expect(await roundTrips(JSON.stringify(draft.manifest))).toBe(true);
  });

  // A guide with one clean assembly and one whose anchor is whatever the test supplies. The shared
  // images directory exists so the draft's sharedGlobs match a real file.
  function guideWithAnchor(anchor: string): Record<string, string> {
    return {
      'titles/aap/master.adoc': `= AAP

include::../../assemblies/assembly_clean.adoc[leveloffset=+1]
include::../../assemblies/assembly_other.adoc[leveloffset=+1]
`,
      'assemblies/assembly_clean.adoc': `[id="assembly_clean"]
= Clean

include::../modules/con_clean.adoc[leveloffset=+1]
`,
      'modules/con_clean.adoc': `= Clean concept
`,
      'assemblies/assembly_other.adoc': `[id="${anchor}"]
= Other

include::../modules/con_other.adoc[leveloffset=+1]
`,
      'modules/con_other.adoc': `= Other concept
`,
      'images/shared.png': 'png',
    };
  }

  it.each([
    ['a bidi control', 'install\u202eguide', 'at position 8: U+202E', '\u202e'],
    ['the empty braille pattern', 'install\u2800guide', 'at position 8: U+2800', '\u2800'],
  ])(
    'refuses the whole draft rather than write a manifest without the page: an anchor with %s',
    async (_label, hostileAnchor, expectedPoint, rawCharacter) => {
      // A page whose id is refused cannot be written, and it cannot be left out either: the docs
      // planner queues every manifest page on a shared-file change and records no gap for a page
      // that is not there, so a manifest missing this page would let an images change read as
      // fully checked while the page is never scanned. The only honest draft is none. The refusal
      // names the file, the position and code point, and the fix, and never the id.
      const fs = memoryFs(guideWithAnchor(hostileAnchor));

      let message = '';
      try {
        await inferAsciidocModular(fs);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('refused to write usabl.docs.json');
      expect(message).toContain('assemblies/assembly_other.adoc: its anchor pageId');
      expect(message).toContain(expectedPoint);
      expect(message).toContain('rename the anchor');
      expect(message).not.toContain(rawCharacter);
      expect(message).not.toContain(hostileAnchor);

      // Nothing was written, so there is no docs surface at all: no manifest to plan a partial
      // wide blast from, and nothing that claims the other page was checked.
      expect(fs.store[DOCS_MANIFEST_PATH]).toBeUndefined();
      expect(await parseDocsManifest(fs)).toBeNull();

      // Once the anchor is fixed the same guide drafts, writes, reparses, and plans with both
      // pages, and a shared-file change queues both of them.
      const fixedFs = memoryFs(guideWithAnchor('install-guide'));
      const draft = await inferAsciidocModular(fixedFs);
      const result = await writeDocsInitDraft(fixedFs, draft, { force: false });
      expect(result.ok).toBe(true);

      const manifest = await parseDocsManifest(fixedFs);
      expect(manifest?.pages.map((page) => page.pageId)).toEqual(['assembly_clean', 'install-guide']);
      expect(manifest?.sharedGlobs).toContain('images/**');

      const direct = computeDocsCoverage(manifest, ['modules/con_other.adoc']);
      expect(direct.affected.map((screen) => screen.screenId)).toEqual(['install-guide']);
      expect(direct.gaps).toEqual([]);

      const wideBlast = computeDocsCoverage(manifest, ['images/shared.png']);
      expect(wideBlast.nothingToCheck).toBe(false);
      expect(wideBlast.affected.map((screen) => screen.screenId).sort()).toEqual(['assembly_clean', 'install-guide']);
      expect(wideBlast.gaps).toEqual([]);
    },
  );

  it('refuses the draft when an assembly without an anchor has a filename that slugs to nothing', async () => {
    // With no anchor the pageId is guessed from the filename, and a filename with no letter or
    // digit slugs to nothing. A blank id is refused by the parser, so the draft is refused here,
    // and the fix names the file rather than an anchor.
    const fs = memoryFs({
      'titles/aap/master.adoc': `= AAP

include::../../assemblies/assembly_ok.adoc[]
include::../../assemblies/__.adoc[]
`,
      'assemblies/assembly_ok.adoc': `[id="assembly_ok"]
= Ok
`,
      'assemblies/__.adoc': `= No anchor and no letters in the name
`,
    });

    await expect(inferAsciidocModular(fs)).rejects.toThrow(
      /assemblies\/__\.adoc: the pageId guessed from its filename must be a non-empty string/,
    );
    await expect(inferAsciidocModular(fs)).rejects.toThrow(/or the file when the id was guessed/);
    expect(fs.store[DOCS_MANIFEST_PATH]).toBeUndefined();
  });

  it('names every unusable page in one refusal, so one run shows the whole fix', async () => {
    const fs = memoryFs({
      'titles/aap/master.adoc': `= AAP

include::../../assemblies/assembly_a.adoc[]
include::../../assemblies/assembly_b.adoc[]
`,
      'assemblies/assembly_a.adoc': `[id="a\u2800a"]
= A
`,
      'assemblies/assembly_b.adoc': `[id="b\u200bb"]
= B
`,
    });

    let message = '';
    try {
      await inferAsciidocModular(fs);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('2 pages have ids');
    expect(message).toContain('assemblies/assembly_a.adoc: its anchor pageId');
    expect(message).toContain('at position 2: U+2800');
    expect(message).toContain('assemblies/assembly_b.adoc: its anchor pageId');
    expect(message).toContain('at position 2: U+200B');
  });

  it('throws a clear error when no assembly resolves into a page', async () => {
    const fs = memoryFs({
      'titles/aap/master.adoc': `= AAP

include::../../assemblies/assembly_missing.adoc[]
`,
    });
    await expect(inferAsciidocModular(fs)).rejects.toThrow(/no.*page/i);
  });
});
