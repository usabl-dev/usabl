/**
 * In-memory Deps so tests can run the whole engine without git, a browser, or a network.
 * Scripted maps are the only source of truth. `browser.open` ignores the URL.
 * Unused Page methods throw: a test that hits them is lying about coverage, not passing.
 */
import type { Deps, ScreenScan, Page } from '../contracts/index.js';

export interface FakeDepsSpec {
  now: string;
  runnerVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
  changed: Array<{ code: string; path: string }>;
  files: Record<string, string>; // working-tree contents by path
  headContents: Record<string, string>; // HEAD contents by path (for git.show)
  headBlobs: Record<string, string>; // blob shas by path (for git.lsTree / policyHash)
  writeTree: string; // git write-tree result
  headRef: string;
  scans: Record<string, ScreenScan>; // by screenId
}

const DEFAULTS: FakeDepsSpec = {
  now: '2026-01-01T00:00:00.000Z',
  runnerVersion: '0.0.0-test',
  scannerVersions: { axeCore: '0.0.0', playwright: '0.0.0', chromium: '0.0.0' },
  changed: [],
  files: {},
  headContents: {},
  headBlobs: {},
  writeTree: 'tree-0000',
  headRef: 'HEAD-0000',
  scans: {},
};

const notUsed = (name: string) => async (): Promise<never> => {
  throw new Error(`fake Page.${name} not used in this test`);
};

function fakePage(): Page {
  return {
    gotoReady: async () => {},
    focusBody: async () => {},
    tab: async () => {},
    press: async () => {},
    activeNode: async () => null,
    activePath: async () => 'body',
    axAt: async () => null,
    queryAll: async () => [],
    close: async () => {},
    setViewport: async () => {},
    setZoom: async () => {},
    setReducedMotion: async () => {},
    getComputedStyle: notUsed('getComputedStyle'),
    screenshot: notUsed('screenshot'),
  };
}

export function makeFakeDeps(overrides: Partial<FakeDepsSpec> = {}): Deps {
  const spec: FakeDepsSpec = { ...DEFAULTS, ...overrides };
  return {
    clock: () => spec.now,
    runnerVersion: spec.runnerVersion,
    scannerVersions: spec.scannerVersions,
    // URL is config for later Playwright wiring. Fakes never fetch it.
    browser: { open: async (_url: string) => fakePage() },
    git: {
      writeTree: async () => spec.writeTree,
      show: async (_ref, path) => spec.headContents[path] ?? null,
      statusZ: async () => spec.changed,
      lsTree: async (_ref, paths) =>
        Object.fromEntries(
          paths.filter((p) => p in spec.headBlobs).map((p) => [p, spec.headBlobs[p] as string]),
        ),
      headRef: async () => spec.headRef,
    },
    fs: {
      readFile: async (path) => spec.files[path] ?? null,
      glob: async (patterns) => Object.keys(spec.files).filter((f) => patterns.some((p) => matchGlob(p, f))),
    },
    checkRunner: {
      scan: async ({ id, url }) => spec.scans[id] ?? { screenId: id, url, stops: [], drafts: [] },
    },
  };
}

/**
 * Tiny glob for tests: `*` is one path segment, `**` is any depth.
 * Encode `**` first so a lone `*` cannot swallow slashes.
 */
function matchGlob(pattern: string, path: string): boolean {
  const rx = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\x00/g, '.*') +
      '$',
  );
  return rx.test(path);
}
