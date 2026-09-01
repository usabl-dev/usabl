import { describe, expect, it } from 'vitest';
import type { Draft, ScreenScan } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { runBaseline } from '../../src/baseline/index.js';
import { testConfig } from '../helpers.js';

// A baseline must capture existing docs debt, not only app debt. runBaseline globs uiFileGlobs for
// app files, but docs source files live outside those globs, so it must also enumerate every docs
// page source from the manifest and feed them to run() so each page is scanned and floored.

class MemoryBaselineFs {
  readonly writes: Array<{ path: string; contents: string }> = [];
  private readonly store = new Map<string, string>();
  async writeFile(path: string, contents: string): Promise<void> {
    this.writes.push({ path, contents });
    this.store.set(path, contents);
  }
  read(path: string): string | null {
    return this.store.get(path) ?? null;
  }
}

function docsManifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 'asciidoc-modular',
    docsBaseUrl: 'http://localhost:8080/docs',
    builtRoot: 'build/html',
    buildCommand: 'npm run build:docs',
    pages: [
      {
        pageId: 'install-guide',
        url: '/install.html',
        assemblyFile: 'modules/install.adoc',
        sources: ['modules/install.adoc'],
      },
    ],
    sharedGlobs: ['modules/_attributes.adoc'],
    ...over,
  });
}

function imageAltDocsDraft(): Draft {
  return {
    rule: 'image-alt',
    layer: 'docs-axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'install-guide',
    elementPath: 'img',
    elementName: null,
    role: null,
    whatUserExperiences: 'Image has no text alternative.',
    why: 'A screen reader announces nothing for this image.',
    fix: 'Add alt text.',
    evidence: { extra: { html: '<img src="setup.png">' } },
    confidence: 'fail',
  };
}

function docsScan(draft: Draft): ScreenScan {
  return {
    screenId: 'install-guide',
    url: 'http://localhost:8080/docs/install.html',
    stops: [],
    drafts: [draft],
    gaps: [],
  };
}

function parseFloor(writer: MemoryBaselineFs): Array<Record<string, unknown>> {
  const raw = writer.read('.usabl-evidence.json');
  if (raw === null) {
    throw new Error('expected .usabl-evidence.json to be written');
  }
  const parsed = JSON.parse(raw) as { entries: Array<Record<string, unknown>> };
  return parsed.entries;
}

describe('runBaseline captures docs debt', () => {
  it('floors a docs page barrier even when no app UI files match the globs', async () => {
    const config = testConfig({ surfaces: [], guardedPaths: ['usabl.config.json', 'usabl.docs.json'] });
    const manifest = docsManifest();
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{}',
        'usabl.docs.json': manifest,
        'modules/install.adoc': '= Install\n\nimage::setup.png[]\n',
      },
      headContents: { 'usabl.config.json': '{}', 'usabl.docs.json': manifest },
      scans: { 'install-guide': docsScan(imageAltDocsDraft()) },
    });
    const writer = new MemoryBaselineFs();

    const result = await runBaseline(deps, config, writer);
    const entries = parseFloor(writer);

    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      screenId: 'install-guide',
      layer: 'docs-axe',
      rule: 'image-alt',
    });
  });

  it('captures app and docs debt together in one floor', async () => {
    const config = testConfig({ guardedPaths: ['usabl.config.json', 'usabl.docs.json'] });
    const manifest = docsManifest();
    const appDraft: Draft = {
      rule: 'color-contrast',
      layer: 'axe',
      severity: 'serious',
      evidenceClass: 'deterministic',
      screenId: 'clusters',
      elementPath: 'button',
      elementName: 'Save',
      role: 'button',
      whatUserExperiences: 'Button text is hard to read.',
      why: 'Contrast is too low.',
      fix: 'Raise contrast to 4.5:1.',
      evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
      confidence: 'fail',
    };
    const appScan: ScreenScan = {
      screenId: 'clusters',
      url: 'http://127.0.0.1:5173/clusters',
      stops: [],
      drafts: [appDraft],
      gaps: [],
    };
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{}',
        'usabl.docs.json': manifest,
        'fixtures/app/src/ClustersPage.tsx': 'export {};\n',
        'modules/install.adoc': '= Install\n\nimage::setup.png[]\n',
      },
      headContents: {
        'usabl.config.json': '{}',
        'usabl.docs.json': manifest,
        'fixtures/app/src/ClustersPage.tsx': 'export {};\n',
      },
      scans: { clusters: appScan, 'install-guide': docsScan(imageAltDocsDraft()) },
    });
    const writer = new MemoryBaselineFs();

    const result = await runBaseline(deps, config, writer);
    const entries = parseFloor(writer);

    expect(result.exitCode).toBe(0);
    const rules = entries.map((entry) => entry['rule']).sort();
    expect(rules).toEqual(['color-contrast', 'image-alt']);
  });
});
