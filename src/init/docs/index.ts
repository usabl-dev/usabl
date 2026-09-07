/**
 * Draft docs-manifest generation for `usabl init --docs`.
 * This unit detects which documentation format the working tree uses, dispatches to
 * the matching adapter, and writes a DRAFT usabl.docs.json for a human to review and
 * commit. It mirrors src/init/index.ts: it infers a draft with heavy "Review:" notes
 * for anything guessed rather than measured, and it refuses to overwrite an existing
 * sidecar without an explicit force. It must never mint a verdict or read the file it
 * just wrote in the same run. A wrong mapping is worse than a gap.
 *
 * The adapter contract is that a draft round-trips through the sidecar parser. That is held
 * here as well as in the adapters: the exact bytes about to be written are parsed in memory
 * first, and a draft the parser would refuse is never written. Parsing before the write is
 * what keeps this unit from reading the file it wrote.
 */
import type { FsGlob } from '../../contracts/index.js';
import { parseDocsManifest, type DocsManifest } from '../../coverage/docs-manifest.js';
import { scrubString } from '../../surfaces/scrub.js';
import { inferAsciidocModular } from './asciidoc-modular.js';
import { inferAsciibinder } from './asciibinder.js';

// The one sidecar init writes. Its presence is what activates the docs surface, so
// overwriting a reviewed copy must stay an explicit operator choice.
export const DOCS_MANIFEST_PATH = 'usabl.docs.json';

// Detection markers, checked in precedence order. A Pantheon guide master wins over an
// AsciiBinder topic map because a repo that has both is a Pantheon repo with a stray map.
const PANTHEON_MASTER_GLOB = 'titles/*/master.adoc';
const ASCIIBINDER_TOPIC_MAP = '_topic_maps/_topic_map.yml';

export interface DocsInitFs {
  readFile(path: string): Promise<string | null>;
  glob(patterns: string[]): Promise<string[]>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface DocsInitDraft {
  // Round-trips through parseDocsManifest without throwing. That is the adapter contract.
  manifest: DocsManifest;
  notes: string[];
}

export interface WriteDocsInitResult {
  ok: boolean;
  written: string[];
  refused: string[];
  message: string;
}

// Returns null when no supported docs format is detected. Antora, MkDocs, and Docusaurus
// are deferred, so their presence is a clean "no docs surface init can draft", not an error.
export async function inferDocsInit(fs: DocsInitFs): Promise<DocsInitDraft | null> {
  const masters = await fs.glob([PANTHEON_MASTER_GLOB]);
  if (masters.length > 0) {
    return inferAsciidocModular(fs);
  }
  if ((await fs.readFile(ASCIIBINDER_TOPIC_MAP)) !== null) {
    return inferAsciibinder(fs);
  }
  return null;
}

export async function writeDocsInitDraft(
  fs: DocsInitFs,
  draft: DocsInitDraft,
  opts: { force: boolean },
): Promise<WriteDocsInitResult> {
  // An existing sidecar is operator-owned and may already be reviewed. Overwrite is
  // explicit so a later re-run cannot clobber it without the operator asking for it.
  if (!opts.force && (await fs.readFile(DOCS_MANIFEST_PATH)) !== null) {
    return {
      ok: false,
      written: [],
      refused: [DOCS_MANIFEST_PATH],
      message: `Refusing to overwrite ${DOCS_MANIFEST_PATH} without --force.`,
    };
  }

  const contents = `${JSON.stringify(draft.manifest, null, 2)}\n`;
  const inMemory: FsGlob = {
    readFile: async (path) => (path === DOCS_MANIFEST_PATH ? contents : null),
    glob: async () => [],
  };
  try {
    await parseDocsManifest(inMemory);
  } catch (error: unknown) {
    // The parser's own message already names the field and, for a refused id, the position and
    // code point without the id. It is scrubbed again here because the whole line reaches a
    // terminal, and scrubbing clean text changes nothing.
    const reason = scrubString(error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      written: [],
      refused: [],
      message: `Refusing to write ${DOCS_MANIFEST_PATH}: usabl would not be able to read it. ${reason}`,
    };
  }

  await fs.writeFile(DOCS_MANIFEST_PATH, contents);
  return {
    ok: true,
    written: [DOCS_MANIFEST_PATH],
    refused: [],
    message: `Wrote ${DOCS_MANIFEST_PATH}.`,
  };
}

export function formatDocsInitReport(draft: DocsInitDraft, result: WriteDocsInitResult): string {
  const lines = [result.message, ...draft.notes];
  return `${lines.join('\n')}\n`;
}
