/**
 * The dev server overlay loads usabl.config.json through the same loader as the CLI. It passes an
 * absolute path that it built from its own cwd and configPath options, so a missing file must be
 * explained in those terms: the overlay has no --config flag to check.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeConfigBackedOverlayRun } from '../../src/surfaces/overlay-host.js';

describe('the config-backed overlay run with no config file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'usabl-overlay-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names the path and the plugin options, never the --config flag', async () => {
    const engine = makeConfigBackedOverlayRun({ cwd: dir });
    const message = await engine.run().then(
      () => '',
      (err: Error) => err.message,
    );
    expect(message).toContain(`${join(dir, 'usabl.config.json')} not found.`);
    expect(message).toContain('configPath');
    expect(message).toContain('usabl init');
    expect(message).not.toContain('--config');
  });
});
