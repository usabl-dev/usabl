/**
 * Level 2 of the sensitivity measurement: the catalog run on the team's own screens, the surfaces
 * in their usabl.config.json at their dev server, with each mutation made in the scan browser.
 *
 * The scans go through buildDeps, the same composition `usabl check` uses, so the provider stack,
 * the design requirements, and the session are the team's own. The one difference is the browser:
 * this command hands buildDeps a browser that can be armed with a mutation, through the browserFor
 * option. No config field or environment variable selects it, so `usabl check`, the stop hook, the
 * CI judge, and checkPage never get it.
 *
 * Every applicable entry loads each screen twice, once clean and once mutated. Only the flow and
 * voice entries need the screen's design requirements, so only their scans run the requirement
 * steps. Every other entry scans with no requirements, so a team's flow and voice steps, which can
 * save or delete data, run only as often as those two entries need.
 */
import type { BrowserDriver, CheckRunner, RequirementBundle, UsablConfig } from '../../contracts/index.js';
import { buildDeps } from '../../deps/build.js';
import { makeFsGlob } from '../../deps/fs.js';
import { loadRequirements } from '../../intake/load.js';
import { makeRealBrowserDriver, type RealBrowserOptions } from '../../deps/real.js';
import { makeMutatingBrowser, type MutatingBrowser } from './browser.js';
import { SENSITIVITY_CATALOG, type CatalogEntry } from './catalog.js';
import type { MutationEditor } from './edits.js';
import { makeRealMutationEditor } from './real-editor.js';
import { measureCatalog, precondition, type EntryMeasurement, type SensitivityScreen } from './runner.js';

const NO_REQUIREMENTS: RequirementBundle = { version: 1, requirements: [] };

export type Level2Screens = { ok: true; screens: SensitivityScreen[] } | { ok: false; message: string };

/** The configured surfaces to measure, all of them or the ones named, in config order. */
export function level2Screens(config: UsablConfig, only: readonly string[] | null): Level2Screens {
  const surfaces = config.surfaces.map((surface): SensitivityScreen => ({ id: surface.id, url: surface.url }));
  if (only === null) {
    return surfaces.length === 0
      ? { ok: false, message: 'usabl.config.json lists no surfaces, so there is no app screen to measure.' }
      : { ok: true, screens: surfaces };
  }
  const known = new Set(surfaces.map((surface) => surface.id));
  const unknown = [...new Set(only)].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `no surface in usabl.config.json has the id ${unknown.join(', ')}. --screen takes the ids listed under surfaces.`,
    };
  }
  const wanted = new Set(only);
  return { ok: true, screens: surfaces.filter((surface) => wanted.has(surface.id)) };
}

export interface Level2Options {
  config: UsablConfig;
  cwd: string;
  screens: readonly SensitivityScreen[];
  now: string;
  entries?: readonly CatalogEntry[];
  editor?: MutationEditor;
  // The base browser, given the options buildDeps resolved. Default: the real scan browser.
  baseBrowser?: (options: RealBrowserOptions) => BrowserDriver;
}

export interface Level2Runners {
  // The team's full provider stack, with their design requirements.
  withRequirements: CheckRunner;
  // The same stack with no requirements, so no flow or voice step runs.
  withoutRequirements: CheckRunner;
  browser: MutatingBrowser;
  requirements: RequirementBundle;
  now: string;
}

/**
 * Every entry on every screen, in catalog order. Only an entry that needs a flow or voice
 * requirement scans with the requirements, so the team's steps run only for those entries.
 */
export async function measureLevel2(
  runners: Level2Runners,
  entries: readonly CatalogEntry[],
  screens: readonly SensitivityScreen[],
): Promise<EntryMeasurement[]> {
  const measurements: EntryMeasurement[] = [];
  for (const entry of entries) {
    const checkRunner = entry.needs?.requirement === undefined ? runners.withoutRequirements : runners.withRequirements;
    measurements.push(
      ...(await measureCatalog(
        { checkRunner, browser: runners.browser, requirements: runners.requirements, now: runners.now },
        [{ entry, screens }],
      )),
    );
  }
  return measurements;
}

export async function runLevel2(options: Level2Options): Promise<EntryMeasurement[]> {
  const entries = options.entries ?? SENSITIVITY_CATALOG;
  const built: { browser: MutatingBrowser | null } = { browser: null };
  // One scan browser serves both compositions below, so only one Chromium runs.
  const browserFor = (resolved: RealBrowserOptions): BrowserDriver => {
    if (built.browser === null) {
      const base = (options.baseBrowser ?? makeRealBrowserDriver)(resolved);
      built.browser = makeMutatingBrowser(base, options.editor ?? makeRealMutationEditor());
    }
    return built.browser;
  };
  // The team's full composition, with their requirements, for the flow and voice entries.
  const withRequirements = await buildDeps(options.config, { cwd: options.cwd, browserFor });
  // The same composition with no requirements, for every other entry. Any warning about the saved
  // session was already printed by the first build.
  const { requirements: _requirements, ...withoutRequirementsConfig } = options.config;
  const withoutRequirements = await buildDeps(withoutRequirementsConfig, { cwd: options.cwd, browserFor, warn: () => undefined });
  try {
    const browser = built.browser;
    if (browser === null) {
      throw new Error('the scan browser was not built');
    }
    return await measureLevel2(
      {
        withRequirements: withRequirements.checkRunner,
        withoutRequirements: withoutRequirements.checkRunner,
        browser,
        requirements: withRequirements.requirements,
        now: options.now,
      },
      entries,
      options.screens,
    );
  } finally {
    await closeBrowser(built.browser);
  }
}

async function closeBrowser(browser: MutatingBrowser | null): Promise<void> {
  if (browser !== null) {
    await browser.close();
  }
}

/** What Level 2 will do to one screen: its page loads, and how often its requirement steps run. */
export interface Level2ScreenCost {
  screen: string;
  loads: number;
  // Loads that run the screen's flow and voice steps.
  loadsWithSteps: number;
  // Flow and voice steps on this screen, run on each of those loads.
  steps: number;
}

/**
 * The real counts for the chosen screens and entries, before anything loads. An entry the screen
 * cannot carry for want of a requirement or a profile loads nothing. One whose target is missing
 * still loads the page once to look, so a load count is an upper bound.
 */
export function level2Cost(
  entries: readonly CatalogEntry[],
  screens: readonly SensitivityScreen[],
  requirements: RequirementBundle | null,
): Level2ScreenCost[] {
  const bundle = requirements ?? NO_REQUIREMENTS;
  return screens.map((screen): Level2ScreenCost => {
    let loads = 0;
    let loadsWithSteps = 0;
    for (const entry of entries) {
      if (entry.needs?.requirement !== undefined && requirements === null) continue;
      if (precondition(entry, screen, bundle) !== null) continue;
      loads += 2;
      if (entry.needs?.requirement !== undefined) loadsWithSteps += 2;
    }
    const steps = bundle.requirements
      .filter((requirement) => requirement.surface === screen.id)
      .reduce((total, requirement) => {
        const assertion = requirement.assertion;
        return assertion.type === 'flow' || assertion.type === 'voice' ? total + assertion.steps.length : total;
      }, 0);
    return { screen: screen.id, loads, loadsWithSteps, steps };
  });
}

export type Level2Requirements = { ok: true; bundle: RequirementBundle } | { ok: false; reason: string };

/** The team's design requirements, read the way a local `usabl check` reads them. */
export async function loadLevel2Requirements(config: UsablConfig, cwd: string): Promise<Level2Requirements> {
  const loaded = await loadRequirements(makeFsGlob({ cwd }), config);
  return loaded.ok ? { ok: true, bundle: loaded.bundle } : { ok: false, reason: loaded.reason };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** What Level 2 is about to do to the team's app, said before it starts, with the real counts. */
export function formatLevel2Warning(costs: readonly Level2ScreenCost[]): string {
  const loads = costs.reduce((total, cost) => total + cost.loads, 0);
  const lines = [
    'usabl verify sensitivity --app: this loads your app many times, with your saved session if there is one.',
    `  Up to ${plural(loads, 'page load')} on ${plural(costs.length, 'screen')}. Each catalog entry loads a screen twice, once clean and once changed.`,
    '  On every load, the dialog and menu probes click each dialog trigger and menu toggle on the screen.',
  ];
  const stepped = costs.filter((cost) => cost.loadsWithSteps > 0 && cost.steps > 0);
  if (stepped.length === 0) {
    lines.push('  No chosen screen has flow or voice steps that the flow and voice entries would run, so none run.');
  } else {
    lines.push("  Only the flow and voice entries run the screen's flow and voice steps:");
    for (const cost of stepped) {
      lines.push(
        `    ${cost.screen}: ${plural(cost.loadsWithSteps, 'load')}, ${plural(cost.steps, 'step')} each time, ${plural(cost.loadsWithSteps * cost.steps, 'step')} in all.`,
      );
    }
    lines.push('  A step that saves or deletes data runs that many times.');
  }
  lines.push('  The app must be running.');
  return `${lines.join('\n')}\n`;
}
