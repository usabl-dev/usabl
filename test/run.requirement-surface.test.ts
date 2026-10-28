import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import type { ScreenScan } from '../src/contracts/index.js';
import { testConfig } from './helpers.js';

// A design requirement whose surface names no screen usabl knows is never scanned. Its provider
// only runs on a screen with that id, and no such screen is ever planned. Before, the run said
// nothing about it, so a misspelled surface turned a requirement off and the run could still read
// as verified.

const config = testConfig({
  requirements: 'requirements/',
  surfaces: [
    { id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] },
    { id: 'reports', url: 'http://127.0.0.1:5173/reports', files: ['fixtures/app/src/ReportsPage.tsx'] },
  ],
});

const configJson = JSON.stringify({
  appBaseUrl: config.appBaseUrl,
  uiFileGlobs: config.uiFileGlobs,
  discovery: config.discovery,
  surfaces: config.surfaces,
  requirements: 'requirements/',
  guardedPaths: config.guardedPaths,
});

function cleanScan(): ScreenScan {
  return {
    screenId: 'clusters',
    url: 'http://127.0.0.1:5173/clusters',
    stops: [],
    drafts: [],
    gaps: [],
    applicability: [],
    reachedSelectorPresent: null,
  };
}

function contentRequirement(id: string, surface: string): string {
  return `
version: 1
requirements:
  - id: ${id}
    kind: content
    surface: ${surface}
    description: The heading names the screen.
    assertion:
      type: content
      selector: h1
      expectedText: Clusters
    approved: true
`;
}

function flowRequirement(id: string, surface: string): string {
  return `
version: 1
requirements:
  - id: ${id}
    kind: flow
    surface: ${surface}
    description: Saving announces that the change was saved.
    assertion:
      type: flow
      steps:
        - do: click
          selector: '#save'
      expectedAnnouncement: Saved
    approved: true
`;
}

function docRequirement(id: string, surface: string): string {
  return `
version: 1
requirements:
  - id: ${id}
    kind: doc
    surface: ${surface}
    description: Alt text documentation artifact exists.
    assertion:
      type: doc
      artifact: alt-text-manifest
    approved: true
`;
}

function depsWith(
  requirementFiles: Record<string, string>,
  options: { changed?: string[]; extraFiles?: Record<string, string> } = {},
) {
  const files: Record<string, string> = {
    'usabl.config.json': configJson,
    '.usabl-evidence.json': JSON.stringify({ version: 2, entries: [] }),
    ...(options.extraFiles ?? {}),
    ...requirementFiles,
  };
  return makeFakeDeps({
    files,
    headContents: { ...files },
    changed: (options.changed ?? ['fixtures/app/src/ClustersPage.tsx']).map((path) => ({ code: 'M', path })),
    scans: { clusters: cleanScan() },
  });
}

function requirementGaps(result: Awaited<ReturnType<typeof run>>) {
  return result.coverage.gaps.filter((gap) => gap.ref.startsWith('requirement:'));
}

describe('run with a requirement for a surface usabl does not know', () => {
  it('discloses a content requirement whose surface matches no screen, and never reads verified', async () => {
    const result = await run(depsWith({ 'requirements/heading.yaml': contentRequirement('heading', 'clustrs') }), config);

    expect(result.verdict).toBe('not_covered');
    expect(requirementGaps(result)).toEqual([
      {
        ref: 'requirement:heading',
        state: 'not-covered',
        reason: expect.stringContaining('clustrs'),
      },
    ]);
    expect(result.receipt).toBeNull();
  });

  it('discloses a flow requirement whose surface matches no screen', async () => {
    const result = await run(depsWith({ 'requirements/save.yaml': flowRequirement('save-announces', 'setings') }), config);

    expect(result.verdict).toBe('not_covered');
    expect(requirementGaps(result).map((gap) => gap.ref)).toEqual(['requirement:save-announces']);
    expect(requirementGaps(result)[0]?.reason).toContain('setings');
  });

  it('gives each such requirement its own gap, in a stable order', async () => {
    const result = await run(
      depsWith({
        'requirements/b.yaml': contentRequirement('zeta', 'nowhere'),
        'requirements/a.yaml': contentRequirement('alpha', 'elsewhere'),
      }),
      config,
    );

    expect(requirementGaps(result).map((gap) => gap.ref)).toEqual(['requirement:alpha', 'requirement:zeta']);
  });

  it('adds no gap for a requirement on a configured screen this change did not touch', async () => {
    // The reports screen exists and is simply out of scope for this change. Gapping it would make
    // every run that changes one screen not covered.
    const result = await run(depsWith({ 'requirements/reports.yaml': contentRequirement('reports-heading', 'reports') }), config);

    expect(requirementGaps(result)).toEqual([]);
    expect(result.verdict).toBe('verified');
  });

  it('adds no gap for a requirement on a screen the route manifest names', async () => {
    const result = await run(
      depsWith(
        { 'requirements/settings.yaml': contentRequirement('settings-heading', 'settings') },
        {
          extraFiles: {
            'usabl.routes.json': JSON.stringify({
              routes: [{ screenId: 'settings', url: '/settings', entryFile: null }],
            }),
          },
        },
      ),
      config,
    );

    expect(requirementGaps(result)).toEqual([]);
    expect(result.verdict).toBe('verified');
  });

  it('adds no gap for a requirement on a page the docs manifest names', async () => {
    const result = await run(
      depsWith(
        { 'requirements/docs.yaml': contentRequirement('docs-heading', 'getting-started') },
        {
          extraFiles: {
            'usabl.docs.json': JSON.stringify({
              format: 'asciidoc-modular',
              docsBaseUrl: 'http://localhost:8080/docs',
              builtRoot: 'build/html',
              buildCommand: 'npm run build:docs',
              pages: [
                {
                  pageId: 'getting-started',
                  url: '/getting-started.html',
                  assemblyFile: 'modules/getting-started.adoc',
                  sources: ['modules/getting-started.adoc'],
                },
              ],
              sharedGlobs: [],
            }),
          },
        },
      ),
      config,
    );

    expect(requirementGaps(result)).toEqual([]);
    expect(result.verdict).toBe('verified');
  });

  it('adds no gap for a doc requirement, which is not a runtime check', async () => {
    const result = await run(depsWith({ 'requirements/doc.yaml': docRequirement('doc-alt', 'nowhere') }), config);

    expect(requirementGaps(result)).toEqual([]);
    expect(result.verdict).toBe('verified');
  });

  it('stays idle when no UI file changed', async () => {
    const result = await run(
      depsWith({ 'requirements/heading.yaml': contentRequirement('heading', 'clustrs') }, { changed: ['README.md'] }),
      config,
    );

    expect(result.coverage.nothingToCheck).toBe(true);
    expect(result.verdict).toBeNull();
    expect(requirementGaps(result)).toEqual([]);
  });
});
