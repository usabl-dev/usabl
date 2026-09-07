/**
 * OpenShift AsciiBinder adapter for `usabl init --docs`.
 * An AsciiBinder repo describes its guides in _topic_maps/_topic_map.yml, a multi-document
 * YAML file with one document per top-level guide. Each document nests Topics down to leaf
 * topics, and every leaf names a source .adoc under a chain of Dir segments. This adapter
 * walks that tree, turns each existing leaf .adoc into a draft page, follows the real
 * include closure for its sources, and never mints a verdict. The rendered url scheme and
 * the build output directory cannot be measured from the tree, so both are emitted with a
 * loud "Review:" note that the operator must confirm.
 */
import { posix } from 'node:path';
import yaml from 'js-yaml';
import { buildAdocIncludeGraph } from '../../coverage/asciidoc-include-graph.js';
import type { DocsManifest, DocsPageEntry } from '../../coverage/docs-manifest.js';
import { operatorText } from '../../intake/config-error.js';
import { describeIdProblem } from '../../intake/id-grammar.js';
import { slug } from '../../primitives/slug.js';
import type { DocsInitDraft, DocsInitFs } from './index.js';

const TOPIC_MAP_PATH = '_topic_maps/_topic_map.yml';
const DISTRO_MAP_PATH = '_distro_map.yml';
const DEFAULT_BUILT_ROOT = '_preview';
const DEFAULT_BUILD_COMMAND = 'asciibinder build';
const DOCS_BASE_URL = 'http://127.0.0.1:0';
const SHARED_GLOB_CANDIDATES = ['images/**', '**/images/**'];

interface Leaf {
  dirChain: string[];
  file: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(rec: Record<string, unknown>, key: string): string | null {
  const value = rec[key];
  return typeof value === 'string' ? value : null;
}

// Walk one topic node. A node with a Topics list is a group and adds its Dir to the chain;
// a node with a File is a leaf. Anything else is malformed and is noted, never dropped silently.
function collectLeaves(node: unknown, dirChain: string[], out: Leaf[], notes: string[]): void {
  const rec = asRecord(node);
  if (rec === null) return;

  const dir = stringField(rec, 'Dir');
  const chain = dir !== null && dir.length > 0 ? [...dirChain, dir] : dirChain;

  const topics = rec['Topics'];
  if (Array.isArray(topics)) {
    for (const topic of topics) collectLeaves(topic, chain, out, notes);
    return;
  }

  const file = stringField(rec, 'File');
  if (file !== null && file.length > 0) {
    out.push({ dirChain: chain, file });
    return;
  }

  const name = stringField(rec, 'Name') ?? '(unnamed)';
  notes.push(`Review: topic "${name}" has neither Topics nor File and was skipped.`);
}

async function discoverSharedGlobs(fs: DocsInitFs): Promise<string[]> {
  const found: string[] = [];
  for (const pattern of SHARED_GLOB_CANDIDATES) {
    if ((await fs.glob([pattern])).length > 0) found.push(pattern);
  }
  return found.length > 0 ? found : ['images/**'];
}

export async function inferAsciibinder(fs: DocsInitFs): Promise<DocsInitDraft> {
  const raw = await fs.readFile(TOPIC_MAP_PATH);
  if (raw === null) {
    throw new Error(`usabl init --docs could not read ${TOPIC_MAP_PATH}.`);
  }

  const notes: string[] = [];
  // js-yaml v4 load/loadAll use the safe default schema, so no custom tag can construct a
  // runtime type. The topic map is multi-document, one YAML document per top-level guide.
  const documents = yaml.loadAll(raw);

  const leaves: Leaf[] = [];
  for (const document of documents) {
    collectLeaves(document, [], leaves, notes);
  }

  if ((await fs.readFile(DISTRO_MAP_PATH)) !== null) {
    notes.push(
      `Review: found ${DISTRO_MAP_PATH}. usabl does not read its distro url mappings yet, so confirm every page url against the real AsciiBinder output.`,
    );
  }

  const pages: DocsPageEntry[] = [];
  const usedPageIds = new Set<string>();

  const uniquePageId = (candidate: string): string => {
    if (!usedPageIds.has(candidate)) {
      usedPageIds.add(candidate);
      return candidate;
    }
    let suffix = 2;
    while (usedPageIds.has(`${candidate}-${suffix}`)) suffix += 1;
    const deduped = `${candidate}-${suffix}`;
    usedPageIds.add(deduped);
    notes.push(
      `Review: two topics resolved to pageId "${candidate}". The second was renamed "${deduped}". Confirm the ids before you commit this file.`,
    );
    return deduped;
  };

  for (const leaf of leaves) {
    const chainWithFile = [...leaf.dirChain, leaf.file];
    const assemblyFile = posix.normalize(`${chainWithFile.join('/')}.adoc`);
    if (assemblyFile.startsWith('..') || posix.isAbsolute(assemblyFile)) {
      notes.push(`Review: topic "${leaf.file}" resolves to "${assemblyFile}", which escapes the repo root, and was skipped.`);
      continue;
    }

    const content = await fs.readFile(assemblyFile);
    if (content === null) {
      notes.push(`Review: topic source ${assemblyFile} does not exist and was skipped.`);
      continue;
    }

    const url = `/${chainWithFile.join('/')}.html`;
    // Defense in depth so a hostile Dir or File name cannot smuggle a url the sidecar parser
    // would reject. Legitimate AsciiBinder path parts never contain these.
    if (url.includes('@') || /%2e|%2f|%5c/i.test(url)) {
      notes.push(`Review: topic "${leaf.file}" produced an unsafe url "${url}" and was skipped.`);
      continue;
    }

    // Ask the question the sidecar parser is going to ask, at the point the id is made. The slug
    // keeps only letters, digits, and hyphens, so the one way it fails the grammar is by coming
    // out empty, which happens when no Dir or File segment has a letter or digit in it. Writing
    // that page would produce a manifest usabl then refuses to read, so it is skipped with a note.
    const candidate = slug(chainWithFile.join('/'));
    const problem = describeIdProblem(candidate);
    if (problem !== null) {
      notes.push(
        `Review: skipped topic source ${operatorText(assemblyFile)}; the pageId slugged from its path ${problem}`,
      );
      continue;
    }
    const pageId = uniquePageId(candidate);
    const graph = await buildAdocIncludeGraph(fs, assemblyFile);
    for (const gap of graph.unresolved) {
      notes.push(`Review: unresolved include in ${gap.from}: "${gap.target}" (${gap.reason}).`);
    }

    pages.push({ pageId, url, assemblyFile, sources: graph.sources });
  }

  if (pages.length === 0) {
    throw new Error(
      `usabl init --docs parsed the AsciiBinder topic map but no leaf topic resolved into a page. Check the Dir and File entries in ${TOPIC_MAP_PATH}.`,
    );
  }

  notes.push(
    `Review: docsBaseUrl uses port 0, so usabl serves builtRoot on an ephemeral local port at run time. Change it if you host the built docs elsewhere.`,
  );
  notes.push(
    `Review: builtRoot defaults to "${DEFAULT_BUILT_ROOT}". You MUST confirm the real ${DEFAULT_BUILD_COMMAND} output directory before you commit this file.`,
  );
  notes.push(
    `Review: buildCommand defaults to "${DEFAULT_BUILD_COMMAND}". Confirm it matches how you build these docs.`,
  );
  notes.push(
    `Review: page urls are a best-effort guess of the AsciiBinder output layout. You MUST verify every url against the real build or distro output before you commit this file.`,
  );
  notes.push(`Review: sharedGlobs are defaults. Confirm they cover your shared images.`);
  notes.push(
    `Review: this is a draft. Merge it only after you confirm every pageId, url, builtRoot, and source list.`,
  );

  const manifest: DocsManifest = {
    format: 'asciibinder',
    docsBaseUrl: DOCS_BASE_URL,
    builtRoot: DEFAULT_BUILT_ROOT,
    buildCommand: DEFAULT_BUILD_COMMAND,
    pages,
    sharedGlobs: await discoverSharedGlobs(fs),
  };

  return { manifest, notes };
}
