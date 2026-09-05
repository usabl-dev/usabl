import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

const execFileAsync = promisify(execFile);

describe('identity stability measurement command', () => {
  it('fails closed when no target app is configured, before it opens a browser', async () => {
    const env = { ...process.env };
    delete env.IDENTITY_STABILITY_BASE_URL;
    delete env.IDENTITY_STABILITY_PATHS;
    delete env.IDENTITY_STABILITY_ROUNDS;
    delete env.IDENTITY_STABILITY_STORAGE_STATE;

    await expect(
      execFileAsync('npm', ['run', 'measure:identity-stability'], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Set IDENTITY_STABILITY_BASE_URL'),
    });
    // Real npm subprocess: shared real-process budget. See test/support/timing.ts.
  }, REAL_PROCESS_BUDGET_MS);

  it('rejects a settle period that is not a whole number of milliseconds, before it opens a browser', async () => {
    const env = { ...process.env };
    env.IDENTITY_STABILITY_BASE_URL = 'https://example.invalid';
    env.IDENTITY_STABILITY_SETTLE_MS = 'soon';
    delete env.IDENTITY_STABILITY_PATHS;
    delete env.IDENTITY_STABILITY_ROUNDS;
    delete env.IDENTITY_STABILITY_STORAGE_STATE;

    await expect(
      execFileAsync('npm', ['run', 'measure:identity-stability'], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('IDENTITY_STABILITY_SETTLE_MS must be a whole number'),
    });
    // Real npm subprocess: shared real-process budget. See test/support/timing.ts.
  }, REAL_PROCESS_BUDGET_MS);
});
