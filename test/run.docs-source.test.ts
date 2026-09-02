import { describe, it, expect } from 'vitest';
import { run } from '../src/run.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import type { Draft, ScreenScan, UsablConfig } from '../src/contracts/index.js';

// A docs run where the finding lives on a manifest page. run() must enrich the finding with a source
// mapping so it speaks the author's AsciiDoc, not the rendered DOM. Source is read from the working
// tree (deps.fs), which the fake serves from `files`.

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json', 'usabl.docs.json'],
};

function manifest(): string {
  return JSON.stringify({
    format: 'asciidoc-modular',
    docsBaseUrl: 'http://localhost:8080/docs',
    builtRoot: 'build/html',
    buildCommand: 'npm run build:docs',
    pages: [
      {
        pageId: 'clusters',
        url: '/clusters.html',
        assemblyFile: 'assemblies/assembly_clusters.adoc',
        sources: ['assemblies/assembly_clusters.adoc', 'modules/proc_create.adoc'],
      },
    ],
    sharedGlobs: ['modules/_attributes.adoc'],
  });
}

// A deterministic-fail image-alt draft on the docs page, carrying the rendered outerHTML axe reports.
function imageAltDraft(): Draft {
  return {
    rule: 'image-alt',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'clusters',
    elementPath: 'img',
    elementName: null,
    role: null,
    whatUserExperiences: 'Image has no text alternative.',
    why: 'A screen reader announces nothing for this image.',
    fix: 'generic finding fix',
    evidence: { extra: { html: '<img src="create-cluster.png">' } },
    confidence: 'fail',
  };
}

function scanOf(draft: Draft): ScreenScan {
  return {
    screenId: 'clusters',
    url: 'http://localhost:8080/docs/clusters.html',
    stops: [],
    drafts: [draft],
    gaps: [],
    applicability: [],
  };
}

describe('run enriches docs findings with source mapping', () => {
  it('names the image:: macro and phrases an AsciiDoc fix from the source in the include closure', async () => {
    const docsManifest = manifest();
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{}',
        'usabl.docs.json': docsManifest,
        'modules/proc_create.adoc': '== Create a cluster\n\nimage::create-cluster.png[]\n',
      },
      headContents: { 'usabl.config.json': '{}', 'usabl.docs.json': docsManifest },
      changed: [{ code: 'M', path: 'modules/proc_create.adoc' }],
      scans: { clusters: scanOf(imageAltDraft()) },
    });

    const result = await run(deps, config);

    expect(result.verdict).toBe('regression');
    expect(result.findings).toHaveLength(1);
    const source = result.findings[0]?.docsSource;
    expect(source).toBeDefined();
    expect(source?.tier).toBe('content');
    expect(source?.file).toBe('modules/proc_create.adoc');
    expect(source?.construct).toBe('image::create-cluster.png');
    expect(source?.line).toBeNull();
    // The fix speaks the author's own markup, never the axe rule id.
    expect(source?.fix).toContain('image::create-cluster.png[');
    expect(source?.fix).not.toContain('image-alt');
  });

  it('falls back to the assembly file when the page sources cannot be read', async () => {
    const docsManifest = manifest();
    const deps = makeFakeDeps({
      // The .adoc sources are deliberately absent from the working tree, so no content matches.
      files: { 'usabl.config.json': '{}', 'usabl.docs.json': docsManifest },
      headContents: { 'usabl.config.json': '{}', 'usabl.docs.json': docsManifest },
      changed: [{ code: 'M', path: 'modules/proc_create.adoc' }],
      scans: { clusters: scanOf(imageAltDraft()) },
    });

    const result = await run(deps, config);

    const source = result.findings[0]?.docsSource;
    expect(source?.tier).toBe('fallback');
    expect(source?.file).toBe('assemblies/assembly_clusters.adoc');
    expect(source?.construct).toBeNull();
    // A fallback never invents a syntax fix; it keeps the finding's own remediation text.
    expect(source?.fix).toBe('generic finding fix');
  });

  it('phrases a heading-order fix in "=" markers from the offending heading text', async () => {
    const docsManifest = manifest();
    const headingDraft: Draft = {
      rule: 'docs-heading-order',
      layer: 'docs-content',
      severity: 'serious',
      evidenceClass: 'deterministic',
      screenId: 'clusters',
      elementPath: 'h4',
      elementName: 'Advanced options',
      role: 'heading',
      whatUserExperiences: 'Heading hierarchy is broken.',
      why: 'An h4 follows an h2 with no h3 between them.',
      fix: 'Use the next heading level down instead of skipping one.',
      evidence: { extra: { fromLevel: 2, toLevel: 4 } },
      confidence: 'fail',
    };
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{}',
        'usabl.docs.json': docsManifest,
        'modules/proc_create.adoc': '== Overview\n\n==== Advanced options\n\nText.\n',
      },
      headContents: { 'usabl.config.json': '{}', 'usabl.docs.json': docsManifest },
      changed: [{ code: 'M', path: 'modules/proc_create.adoc' }],
      scans: { clusters: scanOf(headingDraft) },
    });

    const result = await run(deps, config);

    const source = result.findings[0]?.docsSource;
    expect(source?.tier).toBe('content');
    expect(source?.construct).toBe('==== Advanced options');
    expect(source?.fix).toContain('=== Advanced options');
  });
});
