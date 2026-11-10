/**
 * Level 2 without a browser: only the flow and voice entries run the team's flow and voice steps,
 * across a full catalog run, and the warning printed before the run gives the real counts.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserDriver, Provider, RequirementBundle, UsablConfig } from '../../../src/contracts/index.js';
import { mapRequirementsToProviders } from '../../../src/intake/map-to-providers.js';
import { makeCheckRunner } from '../../../src/providers/check-runner.js';
import { makeStepRunner } from '../../../src/providers/keyboard-walk/steps.js';
import { makeMutatingBrowser } from '../../../src/measure/sensitivity/browser.js';
import { SENSITIVITY_CATALOG } from '../../../src/measure/sensitivity/catalog.js';
import { makeFakeDom, makeFakeDomPage, makeFakeMutationEditor } from '../../../src/measure/sensitivity/fakes.js';
import { formatLevel2Warning, level2Cost, measureLevel2, runLevel2 } from '../../../src/measure/sensitivity/level2.js';
import type { SensitivityScreen } from '../../../src/measure/sensitivity/runner.js';
import { testConfig } from '../../helpers.js';

const NOW = '2026-11-09T00:00:00.000Z';
const SCREEN: SensitivityScreen = { id: 'profile', url: 'http://127.0.0.1:5173/profile' };

// One flow requirement on the profile screen, with two steps.
const BUNDLE: RequirementBundle = {
  version: 1,
  requirements: [
    {
      id: 'profile-saved',
      kind: 'flow',
      surface: 'profile',
      description: 'Saving the profile announces it.',
      approved: true,
      assertion: {
        type: 'flow',
        steps: [
          { do: 'click', selector: '#name' },
          { do: 'click', selector: '#save' },
        ],
        expectedAnnouncement: 'Saved',
      },
    },
  ],
};

const FLOW_YAML = `
version: 1
requirements:
  - id: profile-saved
    kind: flow
    surface: profile
    description: Saving the profile announces it.
    assertion:
      type: flow
      steps:
        - do: click
          selector: '#name'
        - do: click
          selector: '#save'
      expectedAnnouncement: Saved
    approved: true
`;

// A fake page that counts every click a check makes on it.
function countingBrowser(clicks: string[]): BrowserDriver {
  return {
    async open(url) {
      return makeFakeDomPage(makeFakeDom({ elements: [], selectors: {} }), {
        currentUrl: async () => url,
        click: async (selector) => {
          clicks.push(selector);
        },
      });
    },
    close: async () => {},
  };
}

// A provider that reports nothing, so each scan is clean and both scans of every entry run.
const quiet: Provider = { id: 'quiet', layer: 'axe', capabilities: ['live'], run: async () => [] };

describe('measureLevel2', () => {
  it('runs the flow steps only for the flow entry, on both of its scans, across the whole catalog', async () => {
    const clicks: string[] = [];
    const browser = makeMutatingBrowser(countingBrowser(clicks), makeFakeMutationEditor());
    const runner = (providers: Provider[]) =>
      makeCheckRunner({
        browser,
        providers,
        config: testConfig({ surfaces: [] }),
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
        transcriptTabCap: 0,
      });
    const measurements = await measureLevel2(
      {
        withRequirements: runner([quiet, ...mapRequirementsToProviders(BUNDLE)]),
        withoutRequirements: runner([quiet]),
        browser,
        requirements: BUNDLE,
        requirementsError: null,
        now: NOW,
      },
      SENSITIVITY_CATALOG,
      [SCREEN],
    );
    expect(measurements.map((measurement) => measurement.entry)).toEqual(SENSITIVITY_CATALOG.map((entry) => entry.id));
    // Two scans of the flow entry, two steps each. No other entry runs a step.
    expect(clicks).toEqual(['#name', '#save', '#name', '#save']);
    const [cost] = level2Cost(SENSITIVITY_CATALOG, [SCREEN], BUNDLE);
    expect(cost).toMatchObject({ loadsWithSteps: 2, steps: 2 });
    expect((cost?.loadsWithSteps ?? 0) * (cost?.steps ?? 0)).toBe(clicks.length);
  });
});

describe('runLevel2', () => {
  let cwd: string | null = null;

  afterEach(async () => {
    if (cwd !== null) await rm(cwd, { recursive: true, force: true });
    cwd = null;
  });

  it('builds the scans for every other entry without the requirements, so their steps never run', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'usabl-sensitivity-level2-'));
    await mkdir(join(cwd, 'design'));
    await writeFile(join(cwd, 'design', 'profile.yaml'), FLOW_YAML);
    const config: UsablConfig = {
      appBaseUrl: 'http://127.0.0.1:5173',
      uiFileGlobs: ['src/**'],
      discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
      surfaces: [{ id: 'profile', url: SCREEN.url, files: ['src/Profile.tsx'] }],
      guardedPaths: ['usabl.config.json'],
      requirements: 'design',
    };
    const clicks: string[] = [];
    // The real provider stack cannot read a fake page, so each clean scan has a gap and its entry
    // stops there. Only the clean scan of the flow entry runs the two steps.
    const measurements = await runLevel2({
      config,
      cwd,
      screens: [SCREEN],
      now: NOW,
      editor: makeFakeMutationEditor(),
      baseBrowser: () => countingBrowser(clicks),
    });
    expect(measurements).toHaveLength(SENSITIVITY_CATALOG.length);
    expect(clicks).toEqual(['#name', '#save']);
  });
});

describe('runLevel2 when the requirements do not load', () => {
  let cwd: string | null = null;

  afterEach(async () => {
    if (cwd !== null) await rm(cwd, { recursive: true, force: true });
    cwd = null;
  });

  it('reads the flow and voice entries as unreadable with the load reason, never as not applicable', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'usabl-sensitivity-level2-'));
    await mkdir(join(cwd, 'design'));
    await writeFile(join(cwd, 'design', 'broken.yaml'), 'version: 1\nrequirements: [1, 2\n');
    const config: UsablConfig = {
      appBaseUrl: 'http://127.0.0.1:5173',
      uiFileGlobs: ['src/**'],
      discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
      surfaces: [{ id: 'profile', url: SCREEN.url, files: ['src/Profile.tsx'] }],
      guardedPaths: ['usabl.config.json'],
      requirements: 'design',
    };
    const measurements = await runLevel2({
      config,
      cwd,
      screens: [SCREEN],
      now: NOW,
      entries: SENSITIVITY_CATALOG.filter((entry) => entry.needs?.requirement !== undefined),
      editor: makeFakeMutationEditor(),
      baseBrowser: () => countingBrowser([]),
    });
    expect(measurements.map(({ entry, outcome }) => [entry, outcome])).toEqual([
      ['flow-live-region-broken', 'unreadable'],
      ['voice-live-region-broken', 'unreadable'],
    ]);
    for (const measurement of measurements) {
      expect(measurement.reason).toMatch(/^the design requirements could not be loaded, so this entry cannot be measured: requirements path design/);
    }
  });
});

describe('the Level 2 warning', () => {
  it('gives the real page loads and the real step count for the chosen screens', () => {
    const other: SensitivityScreen = { id: 'settings', url: 'http://127.0.0.1:5173/settings' };
    const costs = level2Cost(SENSITIVITY_CATALOG, [SCREEN, other], BUNDLE);
    // Every entry but the voice and docs ones loads the profile screen twice. The settings screen
    // has no flow requirement, so the flow entry does not load it either.
    const plain = SENSITIVITY_CATALOG.filter((entry) => entry.needs === undefined).length;
    expect(costs).toEqual([
      { screen: 'profile', loads: (plain + 1) * 2, loadsWithSteps: 2, steps: 2 },
      { screen: 'settings', loads: plain * 2, loadsWithSteps: 0, steps: 0 },
    ]);
    const warning = formatLevel2Warning(costs);
    expect(warning).toContain('with your saved session if there is one');
    expect(warning).toContain(`Up to ${(plain * 2 + 1) * 2} page loads on 2 screens.`);
    expect(warning).toContain('the dialog and menu probes click each dialog trigger and menu toggle on the screen');
    expect(warning).toContain('    profile: 2 loads, 2 steps each time, 4 steps in all.');
    expect(warning).toContain('A step that saves or deletes data runs that many times.');
    expect(warning).not.toContain('settings:');
    expect(warning.replace(/--app\b/g, '')).not.toMatch(/—|--/);
  });

  it('says when the requirements could not be loaded', () => {
    const warning = formatLevel2Warning(level2Cost(SENSITIVITY_CATALOG, [SCREEN], null), 'requirements path design: bad file');
    expect(warning).toContain(
      '  The design requirements could not be loaded, so no flow or voice steps run, and the flow and voice entries are unreadable: requirements path design: bad file',
    );
  });

  it('says when no chosen screen has steps to run', () => {
    expect(formatLevel2Warning(level2Cost(SENSITIVITY_CATALOG, [SCREEN], { version: 1, requirements: [] }))).toContain(
      'No chosen screen has flow or voice steps that the flow and voice entries would run, so none run.',
    );
  });
});
