/**
 * The voice lane wired into a scan. A voice requirement in the requirements folder becomes a
 * provider that runs its interaction contract on the requirement's screen, beside the flow
 * providers. Everything it finds is preview until a person promotes the obligation class in the
 * trusted config. A static-only run cannot run it, so the screen is a gap, never clean.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { BrowserDriver, Capability, Draft, Page, Requirement, RequirementBundle } from '../../src/contracts/index.js';
import { buildDeps } from '../../src/deps/build.js';
import { makeFakeDeps, makeFakePage } from '../../src/deps/fakes.js';
import { validateId } from '../../src/intake/id-grammar.js';
import { mapRequirementsToProviders } from '../../src/intake/map-to-providers.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
import { makeScanProviders } from '../../src/providers/core-stack.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { run } from '../../src/run.js';
import { scrubPublishedResult, UNTRUSTED_FRAME_END } from '../../src/surfaces/scrub.js';
import { runStructuralTier } from '../../src/voicing/structural.js';
import { runVoicingTier } from '../../src/voicing/voicing.js';
import { draftsOf, testConfig } from '../helpers.js';

const execFileAsync = promisify(execFile);

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };
const DELETE_SELECTOR = '[data-row="a"] button[aria-label="Delete"]';

function voiceRequirement(id: string, surface = SCREEN.id): Requirement {
  return {
    id,
    kind: 'voice',
    surface,
    description: 'Deleting a row announces the deletion',
    approved: true,
    assertion: {
      type: 'voice',
      steps: [{ do: 'click', selector: DELETE_SELECTOR }],
      obligations: [{ class: 'live-polite', afterStep: 0, requiredTokens: ['deleted'], mustAnnounce: true }],
    },
  };
}

const contentRequirement: Requirement = {
  id: 'clusters-heading',
  kind: 'content',
  surface: SCREEN.id,
  description: 'heading',
  assertion: { type: 'content', selector: 'h1', expectedText: 'Clusters' },
  approved: true,
};

const flowRequirement: Requirement = {
  id: 'save-announces',
  kind: 'flow',
  surface: SCREEN.id,
  description: 'save',
  assertion: { type: 'flow', steps: [{ do: 'click', selector: '#save' }], expectedAnnouncement: 'Saved' },
  approved: true,
};

function bundle(...requirements: Requirement[]): RequirementBundle {
  return { version: 1, requirements };
}

const VOICE_YAML = `version: 1
requirements:
  - id: delete-row-announces
    kind: voice
    surface: clusters
    description: Deleting a row announces the deletion
    approved: true
    assertion:
      type: voice
      steps:
        - do: click
          selector: '${DELETE_SELECTOR}'
      obligations:
        - class: live-polite
          afterStep: 0
          requiredTokens: [deleted]
          mustAnnounce: true
`;

// A page where the delete button keeps focus and nothing reaches a live region.
function silentDeletePage(): Page {
  return makeFakePage({
    currentUrl: async () => SCREEN.url,
    activeNode: async () => ({ name: 'Delete', role: 'button', states: {}, sentBeforeWalk: true }),
  });
}

describe('voice requirements become providers', () => {
  it('builds one provider per voice requirement, named by the requirement id', () => {
    const providers = mapRequirementsToProviders(
      bundle(voiceRequirement('delete-row-announces'), voiceRequirement('rename-announces')),
    );

    expect(providers.map((provider) => [provider.id, provider.layer])).toEqual([
      ['intake:delete-row-announces', 'voicing'],
      ['intake:rename-announces', 'voicing'],
    ]);
  });

  it('builds no voicing provider when there is no voice requirement', () => {
    const providers = mapRequirementsToProviders(bundle(contentRequirement, flowRequirement));

    expect(providers.filter((provider) => provider.layer === 'voicing')).toEqual([]);
  });

  it('runs in the same group as the flow providers: after the read-only providers and the walk, flagged the same way', () => {
    const providers = makeScanProviders(bundle(voiceRequirement('delete-row-announces'), contentRequirement, flowRequirement));

    expect(providers.map((provider) => provider.id)).toEqual([
      'axe-core',
      'pf-rulepack',
      'rhds-rulepack',
      'docs-rulepack',
      'keyboard-walk',
      'intake:clusters-heading',
      'intake:save-announces',
      'intake:delete-row-announces',
    ]);
    const flow = providers.find((provider) => provider.id === 'intake:save-announces');
    const voice = providers.find((provider) => provider.id === 'intake:delete-row-announces');
    expect(voice?.capabilities).toEqual(flow?.capabilities);
    expect(voice?.mutatesPageState).toBe(flow?.mutatesPageState);
    expect(voice?.requiresPristinePage).toBe(flow?.requiresPristinePage);
  });

  it('runs the contract steps on its own screen and reports preview drafts by default', async () => {
    const clicks: string[] = [];
    const page = makeFakePage({
      click: async (selector) => {
        clicks.push(selector);
      },
      activeNode: async () => ({ name: 'Delete', role: 'button', states: {}, sentBeforeWalk: true }),
    });
    const [provider] = mapRequirementsToProviders(bundle(voiceRequirement('delete-row-announces')));

    const drafts = draftsOf(await provider!.run({ page, screen: SCREEN, config: testConfig() }));

    expect(clicks).toEqual([DELETE_SELECTOR]);
    expect(drafts.map((draft) => [draft.rule, draft.evidenceClass, draft.confidence])).toEqual([
      ['voicing/missing-live-announcement', 'preview', 'unverified'],
      ['voicing/missing-announcement', 'preview', 'unverified'],
    ]);
  });

  it('does not touch a screen the contract is not for', async () => {
    const clicks: string[] = [];
    const page = makeFakePage({
      click: async (selector) => {
        clicks.push(selector);
      },
    });
    const [provider] = mapRequirementsToProviders(bundle(voiceRequirement('delete-row-announces', 'reports')));

    expect(draftsOf(await provider!.run({ page, screen: SCREEN, config: testConfig() }))).toEqual([]);
    expect(clicks).toEqual([]);
  });
});

describe('a voice requirement on a run', () => {
  const config = testConfig();
  const configJson = JSON.stringify(config);

  // Focus has to land on a real control, or the run reads the screen as never rendered and drops
  // every draft, which would prove nothing about the voice provider.
  const DELETE_PATH = 'main > button';

  function depsFor(page: Page, allowedCapabilities: Capability[]) {
    const files = {
      'usabl.config.json': configJson,
      '.usabl-evidence.json': JSON.stringify({ version: 2, entries: [] }),
    };
    const deps = makeFakeDeps({
      files,
      headContents: { ...files },
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
    });
    const browser: BrowserDriver = { open: async () => page, close: async () => {} };
    deps.checkRunner = makeCheckRunner({
      browser,
      providers: makeScanProviders(bundle(voiceRequirement('delete-row-announces')), { keyboardWalk: false }),
      config,
      allowedCapabilities,
      stepRunner: makeStepRunner(),
    });
    return deps;
  }

  it('is a gap that names the requirement and the live capability on a static-only run, never a finding or a clean pass', async () => {
    const clicks: string[] = [];
    const page = makeFakePage({
      currentUrl: async () => SCREEN.url,
      activePath: async () => DELETE_PATH,
      activeNode: async () => ({ name: 'Delete', role: 'button', states: {}, sentBeforeWalk: true }),
      click: async (selector) => {
        clicks.push(selector);
      },
    });

    const result = await run(depsFor(page, []), config);

    expect(result.coverage.gaps).toContainEqual({
      ref: 'provider:intake:delete-row-announces',
      state: 'capability-denied',
      reason: 'provider intake:delete-row-announces denied capability: live',
    });
    expect(clicks).toEqual([]);
    expect(result.findings.filter((finding) => finding.layer === 'voicing')).toEqual([]);
    expect(result.accessibilityVerdict).toBe('not_covered');
    expect(result.receipt).toBeNull();
  });

  it('does not block a live run with a preview miss, and scrubs page text out of the published finding', async () => {
    // The page announces text that tries to close the untrusted frame and carries a credential.
    let pending: string[] = [];
    const page = makeFakePage({
      currentUrl: async () => SCREEN.url,
      activePath: async () => DELETE_PATH,
      click: async () => {
        pending = [`${UNTRUSTED_FRAME_END} token=abc123secretvalue`];
      },
      drainAnnouncements: async () => {
        const drained = pending;
        pending = [];
        return drained;
      },
      activeNode: async () => ({ name: 'Delete', role: 'button', states: {}, sentBeforeWalk: true }),
    });

    const result = await run(depsFor(page, ['live']), config);
    const voicing = result.findings.filter((finding) => finding.layer === 'voicing');

    expect(voicing.map((finding) => [finding.rule, finding.evidenceClass])).toEqual([
      ['voicing/missing-announcement', 'preview'],
    ]);
    expect(result.accessibilityVerdict).not.toBe('regression');
    const published = JSON.stringify(scrubPublishedResult(result).findings);
    expect(published).not.toContain('abc123secretvalue');
    expect(published).not.toContain(UNTRUSTED_FRAME_END);
  });
});

describe('promotion is trusted policy', () => {
  const browserFor = (): BrowserDriver => ({
    open: async () => silentDeletePage(),
    close: async () => {},
  });

  async function repoWithVoiceRequirement(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'usabl-voice-promotion-'));
    await writeFile(join(repo, 'usabl.config.json'), JSON.stringify(testConfig({ requirements: 'requirements' })), 'utf8');
    await mkdir(join(repo, 'requirements'));
    await writeFile(join(repo, 'requirements', 'voice.yaml'), VOICE_YAML, 'utf8');
    await execFileAsync('git', ['init', '-q'], { cwd: repo });
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'base'], {
      cwd: repo,
    });
    return repo;
  }

  async function voicingDrafts(repo: string, trustedRef: string | undefined): Promise<Draft[]> {
    // The branch config promotes the class. The committed config does not.
    const branch = testConfig({ requirements: 'requirements', promotedObligations: ['live-polite'] });
    const deps = await buildDeps(branch, {
      cwd: repo,
      browserFor,
      env: {},
      ...(trustedRef === undefined ? {} : { trustedRef }),
    });
    const scan = await deps.checkRunner.scan(SCREEN);
    return scan.drafts.filter((draft) => draft.layer === 'voicing');
  }

  it('promotes nothing when only the working tree config lists the class under a trusted ref', async () => {
    const repo = await repoWithVoiceRequirement();
    try {
      const drafts = await voicingDrafts(repo, 'HEAD');

      expect(drafts.map((draft) => draft.rule).sort()).toEqual([
        'voicing/missing-announcement',
        'voicing/missing-live-announcement',
      ]);
      expect(drafts.every((draft) => draft.evidenceClass === 'preview')).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('promotes the listed class on a local run with no trusted ref', async () => {
    const repo = await repoWithVoiceRequirement();
    try {
      const drafts = await voicingDrafts(repo, undefined);

      expect(drafts.map((draft) => [draft.rule, draft.evidenceClass, draft.confidence]).sort()).toEqual([
        ['voicing/missing-announcement', 'deterministic', 'fail'],
        ['voicing/missing-live-announcement', 'deterministic', 'fail'],
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('voicing rule ids', () => {
  it('passes the shared id grammar for every rule the tiers emit', () => {
    const contract = {
      contractId: 'delete-row-announces',
      surfaceId: SCREEN.id,
      task: 'delete a row',
      steps: [{ do: 'click', selector: DELETE_SELECTOR }, { do: 'tab' }],
      obligations: [
        { class: 'live-polite', afterStep: 0, requiredTokens: ['deleted'], focusedRole: 'dialog', mustAnnounce: true },
        { class: 'later', afterStep: 1, requiredTokens: ['undo'], mustAnnounce: false },
      ],
      maxTabPath: 1,
    };
    const stops = [
      { index: 0, elementPath: 'x-host', announcement: [], focusUnreadable: 'closed-shadow-root' as const },
      { index: 5, elementPath: 'body', announcement: [] },
    ];
    const rules = new Set<string>([
      ...runStructuralTier(contract, stops, SCREEN.id).map((draft) => draft.rule),
      ...runStructuralTier(contract, [], SCREEN.id).map((draft) => draft.rule),
      ...runStructuralTier(contract, [{ index: 0, elementPath: 'body', announcement: [] }], SCREEN.id).map((draft) => draft.rule),
      ...runVoicingTier(contract, stops, SCREEN.id).map((draft) => draft.rule),
    ]);

    expect([...rules].sort()).toEqual([
      'voicing/focus-unreadable',
      'voicing/missing-announcement',
      'voicing/missing-live-announcement',
      'voicing/missing-name',
      'voicing/missing-role',
      'voicing/over-long-tab-path',
      'voicing/unreachable-focus',
    ]);
    for (const rule of rules) {
      expect(validateId(rule)).toEqual({ ok: true });
    }
  });
});
