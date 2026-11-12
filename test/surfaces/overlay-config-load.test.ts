/**
 * The dev server overlay loads usabl.config.json through the same loader as the CLI. It passes an
 * absolute path that it built from its own cwd and configPath options, so a missing file must be
 * explained in those terms: the overlay has no --config flag to check.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SharedBrowser } from '../../src/deps/real.js';
import { makeConfigBackedOverlayRun } from '../../src/surfaces/overlay-host.js';
import { testConfig } from '../helpers.js';

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

// A config with no UI globs loads only when usabl.docs.json names a page. The overlay's run reads
// its files from the overlay's cwd, so the manifest that excuses the empty list must be read from
// there too, not from the folder the dev server process happens to start in.
describe('the config-backed overlay run with an empty uiFileGlobs list', () => {
  const DOCS_MANIFEST = JSON.stringify({
    format: 'asciidoc-modular',
    docsBaseUrl: 'http://127.0.0.1:4000',
    builtRoot: 'build/html',
    pages: [{ pageId: 'install', url: '/install/index.html', assemblyFile: 'assemblies/install.adoc', sources: [] }],
    sharedGlobs: [],
  });
  let app: string;
  let elsewhere: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    app = await mkdtemp(join(tmpdir(), 'usabl-overlay-app-'));
    elsewhere = await mkdtemp(join(tmpdir(), 'usabl-overlay-process-'));
    await writeFile(join(app, 'usabl.config.json'), JSON.stringify({ ...testConfig(), uiFileGlobs: [] }), 'utf8');
    process.chdir(elsewhere);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(app, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });

  // The run stops at buildDeps, so reaching it means the config loaded.
  const runOnce = async (): Promise<string> => {
    const engine = makeConfigBackedOverlayRun(
      { cwd: app },
      {
        makeBrowser: () => ({}) as SharedBrowser,
        buildDeps: async () => {
          throw new Error('config loaded');
        },
      },
    );
    return engine.run().then(
      () => '',
      (err: Error) => err.message,
    );
  };

  it('loads when the manifest in its own cwd names a page, with none in the process folder', async () => {
    await writeFile(join(app, 'usabl.docs.json'), DOCS_MANIFEST, 'utf8');
    expect(await runOnce()).toBe('config loaded');
  });

  it('refuses when only the process folder holds a manifest that names a page', async () => {
    await writeFile(join(elsewhere, 'usabl.docs.json'), DOCS_MANIFEST, 'utf8');
    expect(await runOnce()).toContain('empty uiFileGlobs list');
  });
});
