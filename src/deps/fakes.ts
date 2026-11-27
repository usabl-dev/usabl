/**
 * In-memory Deps so tests can run the whole engine without git, a browser, or a network.
 * Scripted maps are the only source of truth. `browser.open` never fetches the URL; it only
 * hands it back as the page's own address, so a fake page is always where it was sent.
 * Unused Page methods throw: a test that hits them is lying about coverage, not passing.
 */
import { createHash } from 'node:crypto';
import type {
  Deps,
  GitReader,
  ListedText,
  RequirementBundle,
  ScreenScan,
  Page,
  ScannerVersions,
  StoredEntry,
  TreeEntry,
} from '../contracts/index.js';
import { matchGlob } from '../primitives/match-glob.js';
import { trimTrailingSlashes } from './fs-glob-reading.js';

export interface FakeDepsSpec {
  now: string;
  runnerVersion: string;
  scannerVersions: ScannerVersions;
  changed: Array<{ code: string; path: string }>;
  diffNames?: string[];
  checkoutState?: Record<string, string>; // git.checkoutState; none means the default state
  files: Record<string, string>; // working-tree contents by path
  headContents: Record<string, string>; // HEAD contents by path (for git.show)
  refContents?: Record<string, Record<string, string>>; // other refs by path
  headBlobs: Record<string, string>; // blob shas by path (for git.lsTree / policyHash)
  writeTree: string; // git write-tree result
  headRef: string;
  scans: Record<string, ScreenScan>; // by screenId
  requirements?: RequirementBundle; // design-intake bundle for the docs surface
}

const DEFAULTS: FakeDepsSpec = {
  now: '2026-01-01T00:00:00.000Z',
  runnerVersion: '0.0.0-test',
  scannerVersions: { axeCore: '0.0.0', playwright: '0.0.0', chromium: '0.0.0' },
  changed: [],
  diffNames: [],
  files: {},
  headContents: {},
  headBlobs: {},
  writeTree: 'tree-0000',
  headRef: 'HEAD-0000',
  scans: {},
  requirements: { version: 1, requirements: [] },
};

const notUsed = (name: string) => async (): Promise<never> => {
  throw new Error(`fake Page.${name} not used in this test`);
};

export function makeFakePage(overrides: Partial<Page> = {}): Page {
  return {
    // No real wait. A declared probe is asked once, as if the page were settled at once, so a fake
    // reports held or timed-out the way the real wait would on a page that never changes.
    gotoReady: async (readyWhen) => {
      if (readyWhen === undefined) return { signal: 'not-declared' };
      return { signal: (await readyWhen.holds()) ? 'held' : 'timed-out' };
    },
    // An empty address is "this fake cannot say where it is", which is the honest default for a
    // page that never navigated. Consumers must make no redirect claim from it. Fakes handed a
    // URL by browser.open report that URL instead.
    currentUrl: async () => '',
    // A fake page issues no requests, so it saw no refused one. Not a claim that a session worked.
    unauthorizedApiRequests: async () => [],
    // Nor any data response, so a declared readiness response is never seen on a fake by default.
    apiResponses: async () => [],
    // A fake page sends nothing, so there is nothing to date against the walk.
    markWalkStart: async () => {},
    // A fake page has no DOM to search, so nothing matches anywhere.
    countEverywhere: async () => 0,
    focusBody: async () => {},
    tab: async () => {},
    press: async () => {},
    click: async () => {},
    activeElementIs: async () => false,
    // No script on a fake page moves focus, so the body never holds focus itself.
    bodyHoldsFocus: async () => false,
    // A fake page has no DOM, so it shows no content. A scripted blank page then stays a blank page.
    pageShowsContent: async () => false,
    activeElementWithin: async () => false,
    armAnnouncementCapture: async () => {},
    // A fake page never changes on its own, so it has settled the moment an action ends. A test
    // that needs a page still changing overrides this.
    settleAfterAction: async () => ({ settled: true, waitedMs: 0 }),
    drainAnnouncements: async () => [],
    // A fake page has no modal dialogs, so what it drains is always decidable. It drains through
    // the page's own drainAnnouncements, so a test that scripts that one scripts both.
    async drainAnnouncementRecord(this: Page) {
      return { texts: await this.drainAnnouncements(), undecidable: null };
    },
    // A fake page cannot say which region wrote a text, so the sources are unknown. It drains
    // through the page's own drainAnnouncementRecord, so a test that scripts that one scripts this.
    async drainAnnouncementSources(this: Page) {
      return { ...(await this.drainAnnouncementRecord()), sources: null };
    },
    activeNode: async () => null,
    activePath: async () => 'body',
    // A fake page has no DOM nodes, so it has no key for one.
    activeElementKey: async () => null,
    // A fake page has no shadow roots or frames, so focus is always where its path says.
    activeFocusUnreadable: async () => null,
    // So no focus is ever in a region it cannot read.
    activeUnreadRegion: async () => null,
    // Nor any modal dialog, so no dialog holds focus.
    activeModalDialogs: async () => [],
    // A fake page has no DOM, so no element has a backend node id to report.
    focusedNodeId: async () => null,
    // Nor one for the control a click step names.
    controlNodeId: async () => null,
    // Nor an accessibility tree. The empty tree never changes on its own, so two reads around an
    // action compare equal unless a test scripts a change.
    fullAxTree: async () => ({ kind: 'tree', documentNodeId: null, nodes: [] }),
    designAxTree: async () => ({ kind: 'tree', nodes: [] }),
    axAt: async () => null,
    // A fake page has no shadow roots and no markup, so neither read finds an element.
    axInShadowRoot: async () => null,
    hostMarkup: async () => null,
    getAttribute: async () => null,
    // A fake page has no DOM, so it cannot find the element. That is not a chain with no live region.
    ancestorAttributes: async () => ({ kind: 'not-found' }),
    queryAll: async () => [],
    // No DOM, so no element sits in a keyed table row, and drafts key as they did before row keys.
    rowContext: async () => ({ kind: 'none' }),
    focusedRowContext: async () => ({ kind: 'none' }),
    close: async () => {},
    setViewport: async () => {},
    setZoom: async () => {},
    setReducedMotion: async () => {},
    getComputedStyle: notUsed('getComputedStyle'),
    boundingBox: notUsed('boundingBox'),
    screenshot: notUsed('screenshot'),
    ...overrides,
  };
}

function normalizePrefix(prefix: string): string {
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
}

/**
 * The fake byte read: the fake text read, as UTF-8 bytes. The fakes store text only, so the two
 * reads always agree, and every fake file has the mode 100644. The byte read and the tree entries
 * call the text reads on the same object at call time, so a test that replaces show, readFile, or
 * lsFilesUnder changes what the guard reads too. A test that needs bytes that are not UTF-8,
 * another mode, a symbolic link, or a submodule uses a real repository.
 */
export function storedEntryOf(text: string | null): StoredEntry | null {
  return text === null ? null : { kind: 'file', mode: '100644', bytes: new TextEncoder().encode(text) };
}

/** The tree entry git would give the fake text: a 100644 blob with git's own SHA-1 id for it. */
export function treeEntryOf(text: string): TreeEntry {
  const bytes = new TextEncoder().encode(text);
  const id = createHash('sha1').update(`blob ${String(bytes.byteLength)}\0`).update(bytes).digest('hex');
  return { mode: '100644', type: 'blob', id };
}

/**
 * The tree entry listing a text-only test reader would give: each path its text read names, as a
 * 100644 blob with git's id for that text. With recursion the names come from lsFilesUnder. The
 * reads are called on the reader at call time, so a test that replaces show or lsFilesUnder
 * changes the listing too. Every entry is a file, so only 'blobs' adds the text, which is the text
 * the id was computed from.
 */
export async function listTextEntries(
  reader: Pick<GitReader, 'show' | 'lsFilesUnder'>,
  ref: string,
  paths: readonly string[],
  options: { recursive: boolean; text?: ListedText },
): Promise<Map<string, TreeEntry>> {
  const names = options.recursive ? await reader.lsFilesUnder(ref, paths) : [...new Set(paths)];
  const entries = new Map<string, TreeEntry>();
  for (const name of names) {
    const text = await reader.show(ref, name);
    if (text !== null) {
      entries.set(name, options.text === 'blobs' ? { ...treeEntryOf(text), text } : treeEntryOf(text));
    }
  }
  return entries;
}

export function makeFakeDeps(overrides: Partial<FakeDepsSpec> = {}): Deps {
  const spec: FakeDepsSpec = { ...DEFAULTS, ...overrides };
  return {
    clock: () => spec.now,
    runnerVersion: spec.runnerVersion,
    scannerVersions: spec.scannerVersions,
    // Fakes never fetch the URL. They do report it back as the page's address, so a fake page
    // stands where it was sent and no test reads a redirect that never happened.
    browser: {
      open: async (url: string) => makeFakePage({ currentUrl: async () => url }),
      close: async () => {},
    },
    git: {
      writeTree: async () => spec.writeTree,
      indexedTree: async () => spec.writeTree,
      show: async (ref, path) => (spec.refContents?.[ref] ?? spec.headContents)[path] ?? null,
      async listEntries(ref, paths, options) {
        return listTextEntries(this, ref, paths, options);
      },
      statusZ: async () => spec.changed,
      diffNameOnly: async () => spec.diffNames ?? [],
      checkoutState: async () => ({ ...spec.checkoutState }),
      lsTree: async (_ref, paths) => {
        const blobs: Array<[string, string]> = [];
        for (const path of paths) {
          const blob = spec.headBlobs[path];
          if (blob !== undefined) {
            blobs.push([path, blob]);
          }
        }
        return Object.fromEntries(blobs);
      },
      lsFiles: async (ref, prefix) => {
        const normalized = normalizePrefix(prefix);
        const childrenPrefix = normalized + '/';
        return Object.keys(spec.refContents?.[ref] ?? spec.headContents)
          .filter((path) => path === normalized || path.startsWith(childrenPrefix))
          .sort();
      },
      lsFilesUnder: async (ref, prefixes) => {
        const bases = prefixes.map(normalizePrefix);
        return Object.keys(spec.refContents?.[ref] ?? spec.headContents)
          .filter((path) => bases.some((base) => base === '' || path === base || path.startsWith(base + '/')))
          .sort();
      },
      headRef: async () => spec.headRef,
      tracksFileMode: async () => true,
    },
    fs: {
      readFile: async (path) => spec.files[path] ?? null,
      async readBytes(path) {
        return storedEntryOf(await this.readFile(path));
      },
      // Every fake file is a regular file, its size the length of its text as UTF-8. A test that
      // needs another kind replaces this read.
      async readLocalFile(path, maxBytes) {
        const text = await this.readFile(path);
        if (text === null) {
          return { kind: 'missing' };
        }
        const bytes = new TextEncoder().encode(text);
        return bytes.byteLength > maxBytes
          ? { kind: 'other' }
          : { kind: 'file', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
      },
      // A fake file is a regular file, and a folder is any path a fake file is under. A test that
      // needs a link or another kind replaces this look.
      pathKind: async (path) => {
        if (spec.files[path] !== undefined) return 'file';
        return Object.keys(spec.files).some((f) => f.startsWith(`${path}/`)) ? 'folder' : null;
      },
      glob: async (patterns) => Object.keys(spec.files).filter((f) => patterns.some((p) => matchGlob(p, f))),
      globUnder: async (folder, patterns) => {
        const under = trimTrailingSlashes(folder);
        return Object.keys(spec.files).filter(
          (f) => (under === '' || f.startsWith(`${under}/`)) && patterns.some((p) => matchGlob(p, under === '' ? f : f.slice(under.length + 1))),
        );
      },
    },
    requirements: spec.requirements ?? { version: 1, requirements: [] },
    checkRunner: {
      scan: async ({ id, url }) =>
        spec.scans[id] ?? {
          screenId: id,
          url,
          stops: [],
          drafts: [],
          gaps: [],
          applicability: [],
          notes: [],
          reachedSelectorPresent: null,
          reachedWhenSelector: null,
        },
    },
  };
}
