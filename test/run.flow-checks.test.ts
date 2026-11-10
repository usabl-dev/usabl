/**
 * Flow requirements at the run level, through the real check runner, step runner, providers, and
 * gate, with a scripted page.
 *
 * The capture runs for the life of the page, so the drain a flow took before its first step held
 * speech that an earlier check caused, and the flow counted it. The flow passed without looking.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import type { Deps, Page, Provider, Step, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../src/deps/fakes.js';
import { mapRequirementsToProviders } from '../src/intake/map-to-providers.js';
import { makeCheckRunner } from '../src/providers/check-runner.js';
import { makeStepRunner } from '../src/providers/keyboard-walk/steps.js';

const SCREEN_URL = 'http://app.test/accounts';

const config: UsablConfig = {
  appBaseUrl: 'http://app.test',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'accounts', url: SCREEN_URL, files: ['fixtures/app/src/AccountsPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

// A page with a Save button. The walk lands on it, then on the body. A click on #save writes
// "Saved" into the live record when the page is set to announce it.
function savePage(live: string[], announces: boolean): Page {
  let cursor = -1;
  const stops = [{ path: '#save', node: { name: 'Save', role: 'button', states: {} } }];
  const at = () => stops[cursor] ?? { path: 'body', node: null };
  return makeFakePage({
    currentUrl: async () => SCREEN_URL,
    tab: async () => {
      cursor += 1;
    },
    click: async (selector) => {
      if (selector === '#save' && announces) live.push('Saved');
    },
    activePath: async () => at().path,
    activeNode: async () => at().node,
    drainAnnouncements: async () => live.splice(0, live.length),
  });
}

// An earlier check that ends with an announcement it never drained, such as a probe whose click
// the page answered with a status message.
function earlierCheck(live: string[]): Provider {
  return {
    id: 'earlier-check',
    layer: 'axe',
    capabilities: ['live'],
    run: async () => {
      live.push('Saved');
      return [];
    },
  };
}

function flowProviders(steps: Step[]): Provider[] {
  return mapRequirementsToProviders({
    version: 1,
    requirements: [
      {
        id: 'save-announces',
        kind: 'flow',
        surface: 'accounts',
        description: 'Saving announces that the change was saved.',
        approved: true,
        assertion: { type: 'flow', steps, expectedAnnouncement: 'Saved' },
      },
    ],
  });
}

function depsFor(page: Page, providers: Provider[]): Deps {
  const files = { 'usabl.config.json': '{}' };
  const base = makeFakeDeps({
    files,
    headContents: files,
    writeTree: 'tree-flow-checks',
    changed: [{ code: 'M', path: 'fixtures/app/src/AccountsPage.tsx' }],
  });
  return {
    ...base,
    checkRunner: makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers,
      config,
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 6,
    }),
  };
}

describe('a flow requirement and speech from before its first step', () => {
  it('does not pass on an announcement an earlier check caused when its own steps announce nothing', async () => {
    const live: string[] = [];
    const providers = [earlierCheck(live), ...flowProviders([{ do: 'tab' }])];
    const r = await run(depsFor(savePage(live, true), providers), config);
    expect(r.findings.filter((f) => f.rule === 'intake:save-announces').map((f) => f.confidence)).toEqual(['fail']);
    expect(r.verdict).toBe('regression');
  });

  it('still passes a flow whose own step announces, after an earlier check announced the same text', async () => {
    const live: string[] = [];
    const providers = [earlierCheck(live), ...flowProviders([{ do: 'click', selector: '#save' }])];
    const r = await run(depsFor(savePage(live, true), providers), config);
    expect(r.findings.filter((f) => f.rule === 'intake:save-announces')).toEqual([]);
    expect(r.coverage.gaps).toEqual([]);
    expect(r.verdict).toBe('verified');
  });
});
