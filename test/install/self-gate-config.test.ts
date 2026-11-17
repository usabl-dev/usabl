/**
 * This repository's own usabl.config.json, as its own gate reads it. The gate judges the build that
 * the repository variables name (fixtures/live, served as is), so a change to the one clean fixture
 * screen must plan that screen, and every path the config names must exist. A config that names a
 * folder that is not in the tree plans nothing, so the gate reads every pull request as idle.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeBrief } from '../../src/brief/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { parseConfigText } from '../../src/intake/load-config.js';
import { globMatcher } from '../../src/primitives/match-glob.js';

const ROOT = new URL('../../', import.meta.url);
const CONFIG_RAW = readFileSync(new URL('usabl.config.json', ROOT), 'utf8');
const SCREEN_FILE = 'fixtures/live/users-screen.html';

function trackedFiles(): string[] {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr}`);
  }
  return listed.stdout.split('\0').filter((path) => path !== '');
}

async function briefFor(changedFiles: string[]) {
  const config = parseConfigText(CONFIG_RAW, () => {});
  const files: Record<string, string> = {
    'usabl.config.json': CONFIG_RAW,
    [SCREEN_FILE]: readFileSync(new URL(SCREEN_FILE, ROOT), 'utf8'),
  };
  const deps = makeFakeDeps({ files, headContents: files });
  return makeBrief({ fs: deps.fs, git: deps.git, config, changedFiles });
}

describe("this repository's own gate config", () => {
  it('loads through the config loader', () => {
    expect(() => parseConfigText(CONFIG_RAW, () => {})).not.toThrow();
  });

  it('plans the users screen for a change to the clean fixture screen', async () => {
    const brief = await briefFor([SCREEN_FILE]);
    expect(brief.nothingToCheck).toBe(false);
    expect(brief.screens.map((screen) => screen.id)).toEqual(['users']);
    expect(brief.screens[0]?.url).toBe('http://127.0.0.1:5173/users-screen.html');
  });

  it('reads a change to other fixtures and to engine source as nothing to check', async () => {
    const brief = await briefFor(['fixtures/live/sign-in.html', 'src/cli.ts']);
    expect(brief.nothingToCheck).toBe(true);
    expect(brief.screens).toEqual([]);
  });

  it('names only paths that exist in the tree', () => {
    const config = parseConfigText(CONFIG_RAW, () => {});
    const tracked = trackedFiles();
    const patterns = [
      ...config.uiFileGlobs,
      ...config.discovery.wideBlastGlobs,
      ...config.surfaces.flatMap((surface) => surface.files),
    ];
    const missing = patterns.filter((pattern) => !tracked.some(globMatcher(pattern)));
    expect(missing).toEqual([]);
    if (config.discovery.routerFile !== '') {
      expect(tracked).toContain(config.discovery.routerFile);
    }
  });
});
