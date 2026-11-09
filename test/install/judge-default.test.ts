/**
 * `usabl install --ci` with no other flag writes the trusted judge workflow: build-app builds the
 * pull request with no secret, and usabl-scan judges the build in the isolated browser without
 * running head code. The older shape, which builds head code in the job that writes the Result
 * and which only the engine's own repository still runs, is not something install can write: no
 * flag selects it, and its rule is never embedded in a generated workflow.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { findCliCommand } from '../../src/surfaces/cli-commands.js';
import { ENGINE_SELF_GATE_SCRIPT, REQUIRED_GATE_SCRIPT, USABL_GATE_WORKFLOW_PATH } from '../../src/install/ci.js';

let workspace: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  workspace = await mkdtemp(join(tmpdir(), 'usabl-judge-default-'));
  process.chdir(workspace);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  await rm(workspace, { recursive: true, force: true });
});

describe('install --ci writes the trusted judge by default', () => {
  it('writes the six-job judge split and never the older rule', async () => {
    expect(await main(['install', '--ci'])).toBe(0);
    const written = await readFile(join(workspace, USABL_GATE_WORKFLOW_PATH), 'utf8');
    const jobs = (load(written) as { jobs: Record<string, unknown> }).jobs;

    expect(Object.keys(jobs)).toEqual(['usabl-engine', 'build-app', 'usabl-scan', 'gate-comment', 'usabl-policy', 'usabl-required']);
    expect(written).toContain('check --ci --trusted-ref "${BASE_SHA}" --isolated-browser');
    expect(written).toContain(REQUIRED_GATE_SCRIPT.split('\n')[0]);
    // The older rule reads the verdict from an artifact. Its distinctive line never appears.
    expect(written).not.toContain('the accessibility verdict from the Result artifact is not a pass');
    expect(ENGINE_SELF_GATE_SCRIPT).toContain('the accessibility verdict from the Result artifact is not a pass');
  });

  it('offers no install flag that selects another gate shape', () => {
    const install = findCliCommand('install');
    const names = install?.flags.map((flag) => flag.name) ?? [];
    expect(names.filter((name) => /legacy|single|simple|three|old/i.test(name))).toEqual([]);
  });
});
