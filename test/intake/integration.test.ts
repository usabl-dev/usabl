import { describe, expect, it } from 'vitest';
import type { Result, ScreenScan } from '../../src/contracts/index.js';
import { generateAltTextManifest } from '../../src/docs/alt-text-manifest.js';
import { generateAnnouncementSnippets } from '../../src/docs/announcement-snippets.js';
import { generateKeyboardPaths } from '../../src/docs/keyboard-paths.js';
import { makeFakePage, makeFakeDeps } from '../../src/deps/fakes.js';
import { loadRequirements } from '../../src/intake/load.js';
import { mapRequirementsToProviders } from '../../src/intake/map-to-providers.js';
import { draftsOf, testConfig } from '../helpers.js';

const REQUIREMENTS_YAML = `
version: 1
requirements:
  - id: content-heading
    kind: content
    surface: clusters
    description: Heading text matches authored copy
    assertion:
      type: content
      selector: h1
      expectedText: Welcome
    approved: true
  - id: doc-alt
    kind: doc
    surface: clusters
    description: Alt text documentation artifact exists
    assertion:
      type: doc
      artifact: alt-text-manifest
    approved: true
`;

function fixtureResult(stops: ScreenScan['stops']): Result {
  return {
    schemaVersion: 'usabl.result.v1',
    verdict: 'verified',
    summary: 'fixture result',
    screens: [
      {
        screenId: 'clusters',
        url: 'http://127.0.0.1:5173/clusters',
        stops,
        drafts: [],
        gaps: [],
        applicability: [],
        reachedSelectorPresent: null,
      },
    ],
    coverage: {
      changedFiles: [],
      affected: [],
      unresolvedFiles: [],
      gaps: [],
      nothingToCheck: false,
    },
    findings: [],
    receipt: {
      schemaVersion: 1,
      sourceTree: 'tree-intake',
      baseRevision: null,
      policyHash: 'policy-intake',
      runnerVersion: '0.0.0-test',
      scannerVersions: {
        axeCore: '4.13.0',
        playwright: '1.62.1',
        chromium: 'revision-123',
      },
      surfaces: ['clusters'],
      coverage: { checked: ['clusters'], notCovered: [] },
      verdict: 'verified',
      findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
      activeWaivers: 0,
      mintedAt: '2026-08-23T00:00:00.000Z',
    },
    dirtyGuardedPaths: [],
    exitCode: 0,
    accessibilityVerdict: 'verified',
    accessibilityExitCode: 0,
    paidDownCount: 0,
  };
}

describe('intake integration', () => {
  it('loads requirements and maps deterministic providers that fail on mismatched content', async () => {
    const deps = makeFakeDeps({
      files: {
        'requirements/content.yaml': REQUIREMENTS_YAML,
      },
    });
    const loaded = await loadRequirements(deps.fs, testConfig({ requirements: 'requirements/' }));

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }

    const providers = mapRequirementsToProviders(loaded.bundle);
    expect(providers).toHaveLength(1);

    const drafts = draftsOf(
      await providers[0]!.run({
        page: makeFakePage({
          axAt: async () => ({ name: 'Home', role: 'heading', states: {} }),
        }),
        screen: { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' },
        config: testConfig({ requirements: 'requirements/' }),
      }),
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'intake:content-heading',
      layer: 'intake-content',
      evidenceClass: 'deterministic',
      confidence: 'fail',
      screenId: 'clusters',
    });
  });

  it('binds doc artifacts to checked receipt coverage with honest evidence refs', async () => {
    const deps = makeFakeDeps({
      files: {
        'requirements/content.yaml': REQUIREMENTS_YAML,
      },
    });
    const loaded = await loadRequirements(deps.fs, testConfig({ requirements: 'requirements/' }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }

    const result = fixtureResult([
      {
        index: 0,
        elementPath: '#heading',
        announcement: [{ kind: 'name', text: 'Welcome', fromTree: true, source: 'ax-tree' }],
      },
    ]);

    const announcements = generateAnnouncementSnippets(result);
    const keyboardPaths = generateKeyboardPaths(result);
    const altManifest = generateAltTextManifest(result, loaded.bundle, 'clusters');

    expect(announcements[0]?.boundToReceipt).toBe('tree-intake');
    expect(announcements[0]?.entries[0]?.evidenceRef).toBe('stop:tree-intake:clusters:0');
    expect(keyboardPaths[0]?.boundToReceipt).toBe('tree-intake');
    expect(keyboardPaths[0]?.entries[0]?.evidenceRef).toBe('stop:tree-intake:clusters:0');

    expect(altManifest.boundToReceipt).toBe('tree-intake');
    expect(altManifest.entries).toHaveLength(1);
    expect(altManifest.entries[0]?.element).toBe('h1');
    expect('evidenceRef' in (altManifest.entries[0] ?? {})).toBe(false);
  });

  it('fails closed with approval_required when requirement YAML is malformed', async () => {
    const result = await loadRequirements(
      makeFakeDeps({
        files: {
          'requirements/bad.yaml': `
version: 1
requirements:
  - id: bad
    kind: content
    surface: clusters
    description: broken
    assertion:
      type: content
      selector: h1
      expectedText: Welcome
    approved: true
  broken: [1, 2
`,
        },
      }).fs,
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
      path: 'requirements/bad.yaml',
    });
  });
});
