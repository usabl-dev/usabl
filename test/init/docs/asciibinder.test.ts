/**
 * The AsciiBinder adapter walks a multi-document topic map to its leaf topics and
 * turns each existing leaf .adoc into a draft page. It must follow nested Topics,
 * skip topics whose source file is missing, and emit only a manifest the sidecar
 * parser accepts. The round-trip through parseDocsManifest is the contract.
 */
import { describe, expect, it } from 'vitest';
import { inferAsciibinder } from '../../../src/init/docs/asciibinder.js';
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

describe('inferAsciibinder', () => {
  it('turns leaf topics into pages, follows nested Topics, and skips a missing source', async () => {
    const fs = memoryFs({
      '_topic_maps/_topic_map.yml': `---
Name: Getting Started
Dir: getting_started
Topics:
  - Name: Overview
    File: overview
  - Name: Advanced
    Dir: advanced
    Topics:
      - Name: Deep Dive
        File: deep_dive
---
Name: Reference
Dir: reference
Topics:
  - Name: Missing
    File: missing_topic
  - Name: API
    File: api
`,
      '_distro_map.yml': `openshift-enterprise:
  name: OpenShift
`,
      'getting_started/overview.adoc': `= Overview

include::snippets/shared.adoc[]
`,
      'getting_started/snippets/shared.adoc': `Shared content.
`,
      'getting_started/advanced/deep_dive.adoc': `= Deep dive

Words.
`,
      'reference/api.adoc': `= API

Words.
`,
    });

    const draft = await inferAsciibinder(fs);

    expect(draft.manifest.format).toBe('asciibinder');
    expect(draft.manifest.builtRoot).toBe('_preview');
    expect(draft.manifest.buildCommand).toBe('asciibinder build');

    const byId = new Map(draft.manifest.pages.map((p) => [p.pageId, p]));
    expect(byId.has('getting-started-overview')).toBe(true);
    expect(byId.has('getting-started-advanced-deep-dive')).toBe(true);
    expect(byId.has('reference-api')).toBe(true);
    // The missing topic must not become a page.
    expect(draft.manifest.pages.some((p) => p.pageId.includes('missing'))).toBe(false);

    const overview = byId.get('getting-started-overview');
    expect(overview?.assemblyFile).toBe('getting_started/overview.adoc');
    expect(overview?.sources).toContain('getting_started/overview.adoc');
    expect(overview?.sources).toContain('getting_started/snippets/shared.adoc');
    expect(overview?.url).toBe('/getting_started/overview.html');

    const deep = byId.get('getting-started-advanced-deep-dive');
    expect(deep?.assemblyFile).toBe('getting_started/advanced/deep_dive.adoc');
    expect(deep?.url).toBe('/getting_started/advanced/deep_dive.html');

    for (const page of draft.manifest.pages) {
      expect(page.url.startsWith('/')).toBe(true);
    }

    expect(draft.notes.some((n) => n.toLowerCase().includes('review') && n.includes('missing_topic'))).toBe(true);
    expect(await roundTrips(JSON.stringify(draft.manifest))).toBe(true);
  });

  it('refuses the draft when a leaf path slugs to an empty pageId rather than leave the page out', async () => {
    // A top-level topic with no Dir and a File made of underscores slugs to nothing. The parser
    // refuses a blank pageId, and a manifest without the page would let a shared-file change
    // read as fully checked while the page is never scanned, so the whole draft is refused.
    const fs = memoryFs({
      '_topic_maps/_topic_map.yml': `---
Name: Loose
Topics:
  - Name: Blank
    File: __
  - Name: Fine
    File: fine
`,
      '__.adoc': `= Blank name
`,
      'fine.adoc': `= Fine
`,
    });

    await expect(inferAsciibinder(fs)).rejects.toThrow(/refused to write usabl\.docs\.json/);
    await expect(inferAsciibinder(fs)).rejects.toThrow(
      /__\.adoc: the pageId slugged from its path must be a non-empty string/,
    );
    expect(fs.store['usabl.docs.json']).toBeUndefined();
  });

  it('throws a clear error when the topic map parses but yields no usable pages', async () => {
    const fs = memoryFs({
      '_topic_maps/_topic_map.yml': `---
Name: Empty
Dir: empty
Topics:
  - Name: Gone
    File: gone
`,
    });
    await expect(inferAsciibinder(fs)).rejects.toThrow(/no.*page/i);
  });
});
