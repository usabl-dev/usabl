/**
 * A requirement no person has approved yet, such as one an import drafted, is shown on every
 * surface and never blocks. Its drafts are preview, and a check that could not run is a preview
 * draft too, because a gap would change the verdict. Once approved, the same requirement blocks.
 */
import { describe, expect, it } from 'vitest';
import type { AxNode, Coverage, Draft, Provider, Requirement, RequirementBundle } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { gate } from '../../src/gate/index.js';
import { mapRequirementsToProviders } from '../../src/intake/map-to-providers.js';
import { NOT_APPROVED_NOTE, shownUntilApproved } from '../../src/intake/requirement-approval.js';
import { ProviderRunFailed, runProviders } from '../../src/providers/index.js';
import { draftsOf, gapsOf, testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

const axNode = (name: string | null): AxNode => ({ name, role: 'heading', states: { level: 2 } });

const content: Requirement = {
  id: 'content-title',
  kind: 'content',
  surface: SCREEN.id,
  description: 'Page heading matches authored text',
  assertion: { type: 'content', selector: 'h1', expectedText: 'Users' },
  approved: false,
};

const heading: Requirement = {
  id: 'figma-clusters-heading-1',
  kind: 'heading',
  surface: SCREEN.id,
  description: 'The heading "Clusters" is level 1, as in the design.',
  assertion: { type: 'heading', name: 'Clusters', level: 1 },
  approved: false,
  source: { tool: 'figma', file: 'MOCKKEY', node: '2:1', version: '4242' },
};

const flowWithBadStep: Requirement = {
  id: 'flow-save',
  kind: 'flow',
  surface: SCREEN.id,
  description: 'Save announces',
  assertion: { type: 'flow', steps: [{ do: 'click' }], expectedAnnouncement: 'Saved' },
  approved: false,
};

function bundleOf(...requirements: Requirement[]): RequirementBundle {
  return { version: 1, requirements };
}

// The page's whole accessibility tree holds the same heading the document search reads.
const headingPage = () =>
  makeFakePage({
    queryAll: async () => [{ selector: 'h1' }],
    axAt: async () => axNode('Clusters'),
    countEverywhere: async () => 1,
    designAxTree: async () => ({
      kind: 'tree',
      nodes: [{ nodeId: 1, parentId: null, role: 'heading', name: 'Clusters', ignored: false, states: {}, busy: false, controls: [] }],
    }),
  });

async function scan(bundle: RequirementBundle, page = headingPage()) {
  return runProviders(mapRequirementsToProviders(bundle), { page, screen: SCREEN, config: testConfig() }, ['live']);
}

const covered: Coverage = {
  changedFiles: ['fixtures/app/src/ClustersPage.tsx'],
  affected: [{ screenId: 'clusters', url: SCREEN.url, provenance: 'manual' }],
  unresolvedFiles: [],
  gaps: [],
  nothingToCheck: false,
};

function gateOn(drafts: Draft[]) {
  return gate({
    coverage: covered,
    guardDivergedPaths: [],
    drafts,
    floor: { version: 2, entries: [] },
    waivers: [],
    now: '2026-01-01T00:00:00.000Z',
    cleanlyScannedScreens: new Set(['clusters']),
  });
}

describe('an unapproved requirement', () => {
  it('reports its findings as preview, and says why', async () => {
    const result = await scan(bundleOf(heading, content));
    expect(result.gaps).toEqual([]);
    expect(result.drafts.map((d) => [d.rule, d.evidenceClass])).toEqual([
      ['intake:figma-clusters-heading-1', 'preview'],
      ['intake:content-title', 'preview'],
    ]);
    for (const draft of result.drafts) {
      expect(draft.why.endsWith(NOT_APPROVED_NOTE)).toBe(true);
    }
  });

  it('never moves the gate verdict, and blocks once approved', async () => {
    const shown = await scan(bundleOf(heading));
    expect(gateOn(shown.drafts).verdict).toBe('verified');

    const approved = await scan(bundleOf({ ...heading, approved: true }));
    expect(approved.drafts[0]).toMatchObject({ evidenceClass: 'deterministic', confidence: 'fail' });
    expect(approved.drafts[0]?.why).not.toContain(NOT_APPROVED_NOTE);
    expect(gateOn(approved.drafts).verdict).toBe('regression');
  });

  it('turns an unconfirmed finding into preview too, so it cannot hold the run at not covered', async () => {
    const two = makeFakePage({
      queryAll: async () => [{ selector: '#a' }, { selector: '#b' }],
      axAt: async () => ({ name: 'Clusters', role: 'heading', states: { level: 1 } }),
      countEverywhere: async () => 2,
    });
    const shown = await scan(bundleOf(heading), two);
    expect(shown.drafts).toHaveLength(1);
    expect(shown.drafts[0]).toMatchObject({ evidenceClass: 'preview', confidence: 'unverified' });
    expect(gateOn(shown.drafts).verdict).toBe('verified');
    const approved = await scan(bundleOf({ ...heading, approved: true }), two);
    expect(gateOn(approved.drafts).verdict).toBe('not_covered');
  });

  it('shows a check that could not run as a preview draft, not a gap', async () => {
    const result = await scan(bundleOf(flowWithBadStep));
    expect(result.gaps).toEqual([]);
    const own = result.drafts.filter((d) => d.layer === 'intake-flow');
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ rule: 'intake:flow-save', evidenceClass: 'preview', confidence: 'unverified' });
    expect(own[0]?.why).toContain('could not be checked');
    expect(own[0]?.why).toContain('the flow ran none of its steps');
    // The silent change rule's own preview drafts still come with it.
    expect(result.drafts.some((d) => d.rule === 'voicing/silent-change')).toBe(true);
    expect(gateOn(result.drafts).verdict).toBe('verified');
  });

  it('keeps the same failure a gap once the requirement is approved', async () => {
    const result = await scan(bundleOf({ ...flowWithBadStep, approved: true }));
    expect(result.gaps.map((gap) => gap.ref)).toEqual(['provider:intake:flow-save']);
  });

  it('keeps only the first line of a thrown error, which can quote markup', async () => {
    const provider: Provider = {
      id: 'intake:content-title',
      layer: 'intake-content',
      capabilities: ['live'],
      run: async () => {
        throw new Error('locator.click: Timeout\nCall log:\n  <button data-row="secret">Delete</button>');
      },
    };
    const output = await shownUntilApproved(content, provider).run({ page: makeFakePage(), screen: SCREEN, config: testConfig() });
    const [only] = draftsOf(output);
    expect(only?.why).toContain('locator.click: Timeout');
    expect(JSON.stringify(output)).not.toContain('data-row');
  });

  it('turns the gaps a provider returns into preview drafts and keeps its drafts that are not deterministic', async () => {
    const provider: Provider = {
      id: 'intake:content-title',
      layer: 'intake-content',
      capabilities: ['live'],
      run: async () => ({
        drafts: [],
        gaps: [{ ref: 'intake:content-title', state: 'not-covered', reason: 'the contract step did not run' }],
      }),
    };
    const output = await shownUntilApproved(content, provider).run({ page: makeFakePage(), screen: SCREEN, config: testConfig() });
    expect(gapsOf(output)).toEqual([]);
    expect(draftsOf(output)).toHaveLength(1);
    expect(draftsOf(output)[0]).toMatchObject({ evidenceClass: 'preview', confidence: 'unverified' });
  });

  it('keeps a failed run partial drafts that are not deterministic', async () => {
    const preview: Draft = {
      rule: 'voicing/silent-change',
      layer: 'voicing',
      severity: 'moderate',
      evidenceClass: 'preview',
      screenId: SCREEN.id,
      elementPath: 'body',
      elementName: null,
      role: null,
      whatUserExperiences: 'x',
      why: 'y',
      fix: 'z',
      evidence: {},
      confidence: 'fail',
    };
    const provider: Provider = {
      id: 'intake:content-title',
      layer: 'intake-content',
      capabilities: ['live'],
      run: async () => {
        throw new ProviderRunFailed('step 1 threw', [preview]);
      },
    };
    const output = draftsOf(
      await shownUntilApproved(content, provider).run({ page: makeFakePage(), screen: SCREEN, config: testConfig() }),
    );
    expect(output.map((d) => d.rule)).toEqual(['voicing/silent-change', 'intake:content-title']);
  });

  it('shows an unapproved voice requirement as preview, even when its obligation class is promoted', async () => {
    const voice: Requirement = {
      id: 'delete-row-announces',
      kind: 'voice',
      surface: SCREEN.id,
      description: 'Deleting a row announces the deletion',
      approved: false,
      assertion: {
        type: 'voice',
        steps: [{ do: 'click', selector: '[data-row="a"] button[aria-label="Delete"]' }],
        obligations: [{ class: 'live-polite', afterStep: 0, requiredTokens: ['deleted'], mustAnnounce: true }],
      },
    };
    // The delete button keeps focus and nothing reaches a live region, so the voice check misses.
    const silent = () =>
      makeFakePage({
        currentUrl: async () => SCREEN.url,
        activeNode: async () => ({ name: 'Delete', role: 'button', states: {} }),
      });
    const config = testConfig({ promotedObligations: ['live-polite'] });
    const voiceRun = (requirement: Requirement) =>
      runProviders(mapRequirementsToProviders(bundleOf(requirement)), { page: silent(), screen: SCREEN, config }, ['live']);

    // Approved, the promoted class blocks.
    const approved = await voiceRun({ ...voice, approved: true });
    expect(approved.drafts.some((d) => d.evidenceClass === 'deterministic' && d.confidence === 'fail')).toBe(true);
    expect(gateOn(approved.drafts).verdict).toBe('regression');

    // Unapproved, the same misses are preview, and the verdict does not move.
    const shown = await voiceRun(voice);
    expect(shown.gaps).toEqual([]);
    expect(shown.drafts.length).toBeGreaterThan(0);
    expect(shown.drafts.every((d) => d.evidenceClass === 'preview')).toBe(true);
    expect(gateOn(shown.drafts).verdict).toBe('verified');
  });

  it('leaves an approved requirement provider exactly as it was', () => {
    const provider: Provider = { id: 'x', layer: 'y', capabilities: ['live'], run: async () => [] };
    expect(shownUntilApproved({ ...content, approved: true }, provider)).toBe(provider);
  });
});
