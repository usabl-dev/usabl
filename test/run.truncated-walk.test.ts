/**
 * Through run() and runBaseline(): a keyboard walk that was cut short is a coverage gap on its
 * screen, never an accepted floor entry. While it was an unverified draft, a baseline written
 * while the walk was cut short floored it, and every later run carried it and read verified,
 * although the controls past the cut were never walked.
 */
import { describe, expect, it } from 'vitest';
import type { Deps, Page, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../src/deps/fakes.js';
import { runBaseline } from '../src/baseline/index.js';
import { makeCheckRunner } from '../src/providers/check-runner.js';
import { makeKeyboardWalkProvider } from '../src/providers/keyboard-walk/index.js';
import { makeStepRunner } from '../src/providers/keyboard-walk/steps.js';
import { run } from '../src/run.js';

const URL = 'http://app.test/jobs';
const BODY = 'html > body';
const config: UsablConfig = {
  appBaseUrl: 'http://app.test',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'jobs', url: URL, files: ['src/JobsPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

/**
 * A page with named controls at #c0, #c1, and so on. With `end`, focus moves to the body after the
 * last control and the next Tab goes back to the first, as in Chromium. Without it, Tab never runs
 * out of controls, as on a long table page.
 */
function walkPage(controls: number, end: boolean): Page {
  let cursor = -1;
  const onBody = (): boolean => end && cursor === controls;
  const pathAt = (): string => {
    if (!end) return `#c${cursor}`;
    if (cursor === controls) return BODY;
    return `#c${cursor > controls ? (cursor - controls - 1) % controls : cursor}`;
  };
  return makeFakePage({
    currentUrl: async () => URL,
    focusBody: async () => {
      cursor = -1;
    },
    tab: async () => {
      cursor += 1;
    },
    activePath: async () => pathAt(),
    activeElementIs: async (selector) => selector === 'body' && onBody(),
    activeNode: async () => (onBody() ? null : { name: 'Open job', role: 'button', states: {} }),
  });
}

function depsWith(page: () => Page, files: Record<string, string>): Deps {
  const all = { 'usabl.config.json': '{}', 'src/JobsPage.tsx': 'export {};\n', ...files };
  const base = makeFakeDeps({ files: all, headContents: all, changed: [{ code: 'M', path: 'src/JobsPage.tsx' }] });
  return {
    ...base,
    checkRunner: makeCheckRunner({
      browser: { open: async () => page(), close: async () => {} },
      providers: [makeKeyboardWalkProvider({ tabCap: 5 })],
      config,
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 3,
    }),
  };
}

class MemoryFloorFs {
  contents: string | null = null;
  async writeFile(_path: string, contents: string): Promise<void> {
    this.contents = contents;
  }
}

describe('a keyboard walk that was cut short', () => {
  it('is not covered on the run after a baseline taken while the walk was cut short', async () => {
    const floorFs = new MemoryFloorFs();
    await runBaseline(depsWith(() => walkPage(40, false), {}), config, floorFs, { partial: true });

    const floorFiles: Record<string, string> = floorFs.contents === null ? {} : { '.usabl-evidence.json': floorFs.contents };
    const result = await run(depsWith(() => walkPage(40, false), floorFiles), config);

    expect(result.verdict).toBe('not_covered');
    expect(result.receipt).toBeNull();
    const gap = result.coverage.gaps.find((g) => g.ref === URL);
    expect(gap?.state).toBe('not-covered');
    expect(gap?.reason).toContain('on screen jobs, the keyboard walk was cut short');
    // Nothing about the cut short walk is written to the floor, so nothing can carry it.
    expect(floorFs.contents ?? '').not.toContain('keyboard-walk-truncated');
  });

  it('refuses a full baseline while the walk is cut short, because the screen is not covered', async () => {
    const floorFs = new MemoryFloorFs();
    const outcome = await runBaseline(depsWith(() => walkPage(40, false), {}), config, floorFs);

    expect(outcome.wrote).toBe(false);
    expect(outcome.exitCode).toBe(3);
  });

  it('reads an old floor entry for a cut short walk as a gap that names the command to refresh the floor', async () => {
    const oldFloor = JSON.stringify({
      version: 3,
      entries: [{ screenId: 'jobs', layer: 'walk', rule: 'keyboard-walk-truncated', elementKey: null, identityBasis: 'count', count: 1 }],
    });
    // The walk completes today, and the old entry is still read as a gap until the floor is rewritten.
    const result = await run(depsWith(() => walkPage(3, true), { '.usabl-evidence.json': oldFloor }), config);

    expect(result.verdict).toBe('not_covered');
    expect(result.receipt).toBeNull();
    const gap = result.coverage.gaps.find((g) => g.ref === '.usabl-evidence.json');
    expect(gap?.state).toBe('not-covered');
    expect(gap?.reason).toContain('usabl baseline');
    expect(result.findings.filter((f) => f.rule === 'keyboard-walk-truncated')).toEqual([]);
  });

  it('still verifies a screen whose walk reaches the end of the page', async () => {
    const result = await run(depsWith(() => walkPage(3, true), {}), config);

    expect(result.verdict).toBe('verified');
    expect(result.coverage.gaps).toEqual([]);
  });

  it('still verifies a screen whose walk ends exactly at the stop cap with the walk complete', async () => {
    // Four controls, the body, and one more Tab that confirms the end: the cap of five stops is
    // reached by the body stop, and the confirming Tab is not a stop.
    const result = await run(depsWith(() => walkPage(4, true), {}), config);

    expect(result.verdict).toBe('verified');
    expect(result.coverage.gaps).toEqual([]);
  });
});
