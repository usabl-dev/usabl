/**
 * When the app's own repository is named usabl, Actions checks it out into usabl/usabl, so
 * ../usabl is the checkout itself. The step that places the engine at ../usabl then prints one line
 * and skips the unpack, so the engine is never unpacked over the app checkout. In any other
 * repository it places the engine there as before. The step runs here with bash, as the runner
 * runs it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLACE_ENGINE_BESIDE_APP, USABL_GATE_WORKFLOW } from '../../src/install/ci.js';
import { USABL_HISTORY_WORKFLOW } from '../../src/install/history-ci.js';

let work: string;
let downloads: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'usabl-engine-guard-'));
  // A stand-in engine archive holding one package.json, packed the way the engine job packs it.
  const engine = join(work, 'engine');
  mkdirSync(engine);
  writeFileSync(join(engine, 'package.json'), '{"name":"usabl"}\n');
  downloads = join(work, 'downloads');
  mkdirSync(downloads);
  const pack = spawnSync('tar', ['--create', '--gzip', '--file', join(downloads, 'usabl-engine.tgz'), '--directory', engine, 'package.json']);
  expect(pack.status).toBe(0);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function runStep(workspace: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', PLACE_ENGINE_BESIDE_APP], {
    env: { ...process.env, GITHUB_WORKSPACE: workspace, DOWNLOAD_DIR: downloads },
    encoding: 'utf8',
  });
}

describe('the step that places the engine at ../usabl', () => {
  it('is the step both the app gate and the history scan run', () => {
    expect(USABL_GATE_WORKFLOW).toContain(PLACE_ENGINE_BESIDE_APP);
    expect(USABL_HISTORY_WORKFLOW).toContain(PLACE_ENGINE_BESIDE_APP);
  });

  it('places the engine next to an app checkout', () => {
    const workspace = join(work, 'shop', 'shop');
    mkdirSync(workspace, { recursive: true });
    const outcome = runStep(workspace);
    expect(outcome.status, outcome.stderr).toBe(0);
    expect(readFileSync(join(work, 'shop', 'usabl', 'package.json'), 'utf8')).toBe('{"name":"usabl"}\n');
  });

  it('prints one line and leaves the checkout alone in a repository named usabl', () => {
    const workspace = join(work, 'usabl', 'usabl');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'package.json'), '{"name":"my-app"}\n');
    const outcome = runStep(workspace);
    expect(outcome.status, outcome.stderr).toBe(0);
    expect(outcome.stdout.trim().split('\n')).toEqual([
      'usabl: ../usabl is this checkout, because this repository is named usabl. The engine is not unpacked there, so the checkout is left as it is. ' +
        'If your app installs usabl from file:../usabl, it cannot build here, because ../usabl holds this checkout and not the engine. ' +
        'Rename the repository to fix that. An app that does not install usabl from that path needs no change.',
    ]);
    expect(readFileSync(join(workspace, 'package.json'), 'utf8')).toBe('{"name":"my-app"}\n');
  });

  it('treats a workspace path with a trailing slash the same way', () => {
    const workspace = join(work, 'usabl', 'usabl');
    mkdirSync(workspace, { recursive: true });
    const outcome = runStep(`${workspace}/`);
    expect(outcome.status, outcome.stderr).toBe(0);
    expect(existsSync(join(workspace, 'package.json'))).toBe(false);
  });

  it('says in its comment what happens in a repository named usabl', () => {
    expect(PLACE_ENGINE_BESIDE_APP).toContain('# When this repository is itself named usabl, ../usabl is this checkout, so the step');
  });
});
