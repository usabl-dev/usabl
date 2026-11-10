/**
 * build-app and the history scan unpack the engine into ../usabl, next to the app checkout, for an
 * app whose lockfile installs usabl from file:../usabl. An app that does not use that path never
 * reads the folder. The folder already exists when the app's own repository is named usabl,
 * because Actions checks out into <name>/<name>, so ../usabl is the checkout itself. The step must
 * still pass there, and its comment must not claim every app pins usabl that way.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USABL_GATE_WORKFLOW } from '../../src/install/ci.js';
import { USABL_HISTORY_WORKFLOW } from '../../src/install/history-ci.js';

const DRAFTS: Array<[string, string]> = [
  ['the app gate', USABL_GATE_WORKFLOW],
  ['the history workflow', USABL_HISTORY_WORKFLOW],
];

const siblingMkdirs = (workflow: string): string[] =>
  workflow.split('\n').filter((line) => /^\s*mkdir\b/.test(line) && line.includes('${GITHUB_WORKSPACE}/../usabl'));

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'usabl-engine-sibling-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('the step that places the engine next to the app', () => {
  it.each(DRAFTS)('%s says what the step does, not that every lockfile pins usabl', (_name, workflow) => {
    expect(workflow).not.toContain('the lockfile pins usabl as file:../usabl');
    expect(workflow).toContain('# This places the engine in ../usabl for an app whose lockfile installs usabl from file:../usabl.');
    expect(siblingMkdirs(workflow)).toHaveLength(1);
  });

  it.each(DRAFTS)('%s passes when ../usabl already exists, as in a repository named usabl', (_name, workflow) => {
    const workspace = join(work, 'usabl', 'usabl');
    mkdirSync(workspace, { recursive: true });
    for (const line of siblingMkdirs(workflow)) {
      const outcome = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', line.trim()], {
        env: { ...process.env, GITHUB_WORKSPACE: workspace },
        encoding: 'utf8',
      });
      expect(outcome.status, outcome.stderr).toBe(0);
    }
  });
});
