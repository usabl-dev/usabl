import { describe, expect, it, vi } from 'vitest';
import type { AxNode, Draft, Page, Provider } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

interface ScriptedPageSpec {
  activePaths: string[];
  activeNodes: Array<AxNode | null>;
  onClose?: () => void;
}

function readAt<T>(values: T[], index: number, fallback: T): T {
  return values[index] ?? fallback;
}

async function makeScriptedPage(spec: ScriptedPageSpec): Promise<Page> {
  const deps = makeFakeDeps();
  const page = await deps.browser.open(SCREEN.url);
  let cursor = -1;
  const currentIndex = (): number => (cursor < 0 ? 0 : cursor);

  return Object.assign(page, {
    tab: async () => {
      cursor += 1;
    },
    activePath: async () => readAt(spec.activePaths, currentIndex(), '#first'),
    activeNode: async () => readAt(spec.activeNodes, currentIndex(), null),
    drainAnnouncements: async () => [],
    close: async () => {
      spec.onClose?.();
    },
  });
}

function makeDraft(rule: string): Draft {
  return {
    rule,
    layer: 'fake',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: SCREEN.id,
    elementPath: '#first',
    elementName: 'Save',
    role: 'button',
    whatUserExperiences: 'A button has no accessible name',
    why: 'AT users hear an unlabeled control',
    fix: 'Add an accessible name to the button',
    evidence: {},
    confidence: 'fail',
  };
}

describe('makeCheckRunner', () => {
  it('records transcript stops, provider drafts, and capability-denied gaps', async () => {
    const page = await makeScriptedPage({
      activePaths: ['#first', '#second', '#first'],
      activeNodes: [
        { name: 'Save', role: 'button', states: {} },
        { name: 'Cancel', role: 'button', states: {} },
        { name: 'Save', role: 'button', states: {} },
      ],
    });
    const allowedDraft = makeDraft('allowed-provider-rule');
    const allowedProvider: Provider = {
      id: 'allowed-live',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<Draft[]> => [allowedDraft],
    };
    const deniedRun = vi.fn(async (): Promise<Draft[]> => [makeDraft('should-not-run')]);
    const deniedProvider: Provider = {
      id: 'needs-net',
      layer: 'fake',
      capabilities: ['network'],
      run: deniedRun,
    };
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [allowedProvider, deniedProvider],
      config: testConfig(),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(deniedRun).not.toHaveBeenCalled();
    expect(scan.drafts).toEqual([allowedDraft]);
    expect(scan.stops.length).toBeGreaterThan(0);
    expect(scan.gaps).toEqual([
      {
        ref: 'provider:needs-net',
        state: 'capability-denied',
        reason: 'provider needs-net denied capability: network',
      },
    ]);
  });

  it('turns provider throws into not-covered gaps and closes the page', async () => {
    let closeCalls = 0;
    const page = await makeScriptedPage({
      activePaths: ['#first', '#first'],
      activeNodes: [{ name: 'Save', role: 'button', states: {} }, { name: 'Save', role: 'button', states: {} }],
      onClose: () => {
        closeCalls += 1;
      },
    });
    const thrower: Provider = {
      id: 'thrower',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<Draft[]> => {
        throw new Error('provider exploded');
      },
    };
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [thrower],
      config: testConfig(),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(scan.drafts).toEqual([]);
    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]).toMatchObject({
      ref: 'provider:thrower',
      state: 'not-covered',
    });
    expect(scan.gaps[0]?.reason).toContain('provider exploded');
    expect(closeCalls).toBe(1);
  });

  it('threads the scan profile into the provider context and defaults to app', async () => {
    const seen: Array<string | undefined> = [];
    const spy: Provider = {
      id: 'profile-spy',
      layer: 'fake',
      capabilities: ['live'],
      run: async (ctx): Promise<Draft[]> => {
        seen.push(ctx.profile);
        return [];
      },
    };
    const runnerFor = (page: Page) =>
      makeCheckRunner({
        browser: { open: async () => page, close: async () => {} },
        providers: [spy],
        config: testConfig(),
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
      });

    const docsPage = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    await runnerFor(docsPage).scan({ ...SCREEN, profile: 'docs' });
    expect(seen).toEqual(['docs']);

    seen.length = 0;
    const appPage = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    await runnerFor(appPage).scan(SCREEN);
    expect(seen).toEqual(['app']);
  });

  it('returns a not-covered gap when browser.open throws and never rejects', async () => {
    const runner = makeCheckRunner({
      browser: {
        open: async (): Promise<Page> => {
          throw new Error('open failed');
        },
        close: async () => {},
      },
      providers: [],
      config: testConfig(),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    await expect(runner.scan(SCREEN)).resolves.toEqual({
      screenId: SCREEN.id,
      url: SCREEN.url,
      stops: [],
      drafts: [],
      gaps: [
        {
          ref: SCREEN.url,
          state: 'not-covered',
          reason: 'screen failed to open: open failed',
        },
      ],
    });
  });
});
