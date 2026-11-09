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
 * Every applicable entry loads each screen twice, once clean and once mutated.
 */
import type { BrowserDriver, UsablConfig } from '../../contracts/index.js';
import { buildDeps } from '../../deps/build.js';
import { makeRealBrowserDriver, type RealBrowserOptions } from '../../deps/real.js';
import { makeMutatingBrowser, type MutatingBrowser } from './browser.js';
import { SENSITIVITY_CATALOG, type CatalogEntry } from './catalog.js';
import type { MutationEditor } from './edits.js';
import { makeRealMutationEditor } from './real-editor.js';
import { measureCatalog, type EntryMeasurement, type SensitivityScreen } from './runner.js';

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

export async function runLevel2(options: Level2Options): Promise<EntryMeasurement[]> {
  const entries = options.entries ?? SENSITIVITY_CATALOG;
  const built: { browser: MutatingBrowser | null } = { browser: null };
  const deps = await buildDeps(options.config, {
    cwd: options.cwd,
    browserFor: (resolved) => {
      const base = (options.baseBrowser ?? makeRealBrowserDriver)(resolved);
      const browser = makeMutatingBrowser(base, options.editor ?? makeRealMutationEditor());
      built.browser = browser;
      return browser;
    },
  });
  try {
    const browser = built.browser;
    if (browser === null) {
      throw new Error('the scan browser was not built');
    }
    return await measureCatalog(
      { checkRunner: deps.checkRunner, browser, requirements: deps.requirements, now: options.now },
      entries.map((entry) => ({ entry, screens: options.screens })),
    );
  } finally {
    await deps.browser.close();
  }
}

/** How many page loads Level 2 makes at most: two per entry per screen. */
export function level2LoadCount(entries: number, screens: number): number {
  return entries * screens * 2;
}
