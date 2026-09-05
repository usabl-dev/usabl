import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

const execFileAsync = promisify(execFile);

describe('Fleet Insights measurement command', () => {
  it('reaches session validation and fails closed when no session is configured', async () => {
    const env = { ...process.env };
    delete env.FLEET_INSIGHTS_STORAGE_STATE;
    delete env.FLEET_INSIGHTS_BASE_URL;

    await expect(
      execFileAsync('npm', ['run', 'measure:fleet-insights'], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Set FLEET_INSIGHTS_STORAGE_STATE'),
    });
    // Spawns a real npm subprocess, so it uses the shared real-process budget: generous
    // enough that a busy machine cannot decide the outcome. See test/support/timing.ts.
  }, REAL_PROCESS_BUDGET_MS);
});
