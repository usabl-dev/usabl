/**
 * The Pantheon adapter turns guide masters into a draft docs manifest. It must
 * read the anchor an author wrote, follow the real include closure for each
 * assembly, and never emit a manifest that the sidecar parser would reject. The
 * round-trip through parseDocsManifest is the contract these tests hold.
 */
import { describe, expect, it } from 'vitest';
import { inferAsciidocModular } from '../../../src/init/docs/asciidoc-modular.js';
import { parseDocsManifest } from '../../../src/coverage/docs-manifest.js';
import type { DocsInitFs } from '../../../src/init/docs/index.js';
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

  it('throws a clear error when no assembly resolves into a page', async () => {
    const fs = memoryFs({
      'titles/aap/master.adoc': `= AAP

include::../../assemblies/assembly_missing.adoc[]
`,
    });
    await expect(inferAsciidocModular(fs)).rejects.toThrow(/no.*page/i);
  });
});
