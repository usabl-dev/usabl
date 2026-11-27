/**
 * The session pins also carry the local checkout state: the sparse checkout settings and pattern
 * file, and the submodule folders that are empty. The working tree walk reads a missing file as
 * left out on purpose under that state, and the state moves only through files the agent can write,
 * so the Stop hook must see a change to it during a session as drift, as it sees a changed guarded
 * file. A state that does not change, and the default state, change no pin.
 */
import { describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { computeSessionPins, diffSessionPins } from '../../src/trust/guard.js';

const config: UsablConfig = {
  appBaseUrl: 'https://app.example.test',
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

const SPARSE = '.git/info/sparse-checkout';
const SUBMODULES = '.git/modules';
const headContents = { 'usabl.config.json': '{"guardedPaths":["usabl.config.json"]}' };

function pinsWith(checkoutState?: Record<string, string>, guardedPaths: string[] = config.guardedPaths) {
  return computeSessionPins(makeFakeDeps({ headContents, files: headContents, ...(checkoutState === undefined ? {} : { checkoutState }) }), {
    ...config,
    guardedPaths,
  });
}

describe('the checkout state in the session pins', () => {
  it('adds no pin for the default state', async () => {
    const pins = await pinsWith();
    expect(Object.keys(pins)).not.toContain(SPARSE);
    expect(Object.keys(pins)).not.toContain(SUBMODULES);
    expect(diffSessionPins(pins, await pinsWith({}))).toEqual([]);
  });

  it('pins each state by name, in the current pin format', async () => {
    const pins = await pinsWith({ [SPARSE]: '[["",true,"true",["file","aa"]]]', [SUBMODULES]: '["lib"]' });
    expect(pins[SPARSE]).toMatch(/^v4:[0-9a-f]{64}$/u);
    expect(pins[SUBMODULES]).toMatch(/^v4:[0-9a-f]{64}$/u);
  });

  it('reads a state that does not change as no drift', async () => {
    const state = { [SPARSE]: '[["",true,"true",["file","aa"]]]' };
    expect(diffSessionPins(await pinsWith(state), await pinsWith(state))).toEqual([]);
  });

  it('reads sparse checkout turned on, other patterns, and an emptied submodule folder as drift', async () => {
    const before = await pinsWith();
    expect(diffSessionPins(before, await pinsWith({ [SPARSE]: '[["",true,"",["file","aa"]]]' }))).toEqual([SPARSE]);
    const sparse = await pinsWith({ [SPARSE]: '[["",true,"",["file","aa"]]]' });
    expect(diffSessionPins(sparse, await pinsWith({ [SPARSE]: '[["",true,"",["file","bb"]]]' }))).toEqual([SPARSE]);
    expect(diffSessionPins(sparse, await pinsWith({ [SPARSE]: '[["",true,"",["folder"]]]' }))).toEqual([SPARSE]);
    expect(diffSessionPins(before, await pinsWith({ [SUBMODULES]: '["lib"]' }))).toEqual([SUBMODULES]);
  });

  it('keeps a guarded path of the same name: a change to either one is drift', async () => {
    const guarded = [...config.guardedPaths, SPARSE];
    const state = { [SPARSE]: '[["",true,"",["file","aa"]]]' };
    const before = await pinsWith(state, guarded);
    expect(Object.keys(before)).toContain(SPARSE);
    expect(diffSessionPins(before, await pinsWith(state, guarded))).toEqual([]);
    expect(diffSessionPins(before, await pinsWith({ [SPARSE]: '[["",true,"",["file","bb"]]]' }, guarded))).toEqual([SPARSE]);
    expect(diffSessionPins(before, await pinsWith({}, guarded))).toEqual([SPARSE]);
    // The guarded path alone, with no checkout state, pins as it did before.
    const alone = await pinsWith({}, guarded);
    expect(diffSessionPins(alone, await computeSessionPins(makeFakeDeps({ headContents, files: headContents }), { ...config, guardedPaths: guarded }))).toEqual([]);
  });

  it('pins the guarded files as before when the checkout state is the default', async () => {
    const pins = await pinsWith();
    expect(Object.keys(pins).sort()).toEqual(
      Object.keys(await computeSessionPins(makeFakeDeps({ headContents, files: headContents }), config)).sort(),
    );
    expect(Object.keys(pins)).toContain('usabl.config.json');
  });
});
