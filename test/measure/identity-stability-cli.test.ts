import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

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
  }, 15_000);
});
