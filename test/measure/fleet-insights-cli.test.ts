import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

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
  }, 15_000);
});
