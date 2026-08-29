import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { buildDeps, hashEngineFiles } from '../../src/deps/build.js';
import { testConfig } from '../helpers.js';

const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
const execFileAsync = promisify(execFile);

function readVersion(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return value;
}

describe('buildDeps', () => {
  it('builds real Deps and keeps browser launch lazy', async () => {
    const launchSpy = vi.spyOn(chromium, 'launch');

    try {
      const deps = await buildDeps(testConfig());
      expect(launchSpy).not.toHaveBeenCalled();
      expect(typeof deps.checkRunner.scan).toBe('function');
      expect(typeof deps.browser.open).toBe('function');
      expect(typeof deps.git.statusZ).toBe('function');
      expect(typeof deps.fs.glob).toBe('function');
      await deps.browser.close();
    } finally {
      launchSpy.mockRestore();
    }
  });

  it('reads runner and scanner versions for receipt metadata', async () => {
    const deps = await buildDeps(testConfig());
    const packageJson: unknown = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    const packageVersion =
      typeof packageJson === 'object' && packageJson !== null ? readVersion(Reflect.get(packageJson, 'version')) : null;

    // runnerVersion binds the engine: package version plus a sha256 prefix over the
    // on-disk engine files, so any engine change invalidates a prior receipt (ground-truth s10).
    expect(deps.runnerVersion.startsWith(`${packageVersion}+`)).toBe(true);
    expect(deps.runnerVersion).toMatch(/^.+\+[0-9a-f]{64}$/);
    expect(deps.scannerVersions.axeCore).toMatch(/\S+/);
    expect(deps.scannerVersions.playwright).toMatch(/\S+/);
    expect(deps.scannerVersions.chromium).toMatch(/\S+/);

    await deps.browser.close();
  });

  it('uses cwd for git and filesystem adapters', async () => {
    const fixtureRepo = await mkdtemp(join(tmpdir(), 'usabl-builddeps-'));
    await execFileAsync('git', ['init'], { cwd: fixtureRepo });
    await writeFile(join(fixtureRepo, 'cwd-marker.txt'), 'cwd-ok', 'utf8');

    const deps = await buildDeps(testConfig(), { cwd: fixtureRepo });
    try {
      await expect(deps.fs.readFile('cwd-marker.txt')).resolves.toBe('cwd-ok');
      await expect(deps.git.statusZ()).resolves.toContainEqual({ code: '??', path: 'cwd-marker.txt' });
    } finally {
      await deps.browser.close();
      await rm(fixtureRepo, { recursive: true, force: true });
    }
  });

  it('accepts storageStatePath and keeps browser launch lazy', async () => {
    const launchSpy = vi.spyOn(chromium, 'launch');
    const storageStatePath = '/tmp/fleet-insights-session.json';

    try {
      const deps = await buildDeps(testConfig(), { storageStatePath });
      expect(launchSpy).not.toHaveBeenCalled();
      expect(typeof deps.checkRunner.scan).toBe('function');
      await deps.browser.close();
    } finally {
      launchSpy.mockRestore();
    }
  });
});

describe('hashEngineFiles', () => {
  it('is deterministic and independent of input order', () => {
    const forward = [
      { path: 'a.ts', content: 'alpha' },
      { path: 'b.ts', content: 'beta' },
    ];
    const reversed = [
      { path: 'b.ts', content: 'beta' },
      { path: 'a.ts', content: 'alpha' },
    ];

    expect(hashEngineFiles(forward)).toBe(hashEngineFiles(reversed));
  });

  it('changes when any engine file content changes', () => {
    const base = [
      { path: 'a.ts', content: 'alpha' },
      { path: 'b.ts', content: 'beta' },
    ];
    const tampered = [
      { path: 'a.ts', content: 'alpha' },
      { path: 'b.ts', content: 'beta-tampered' },
    ];

    expect(hashEngineFiles(tampered)).not.toBe(hashEngineFiles(base));
  });

  it('changes when an engine file is renamed', () => {
    const base = [{ path: 'src/run.ts', content: 'engine' }];
    const renamed = [{ path: 'src/run-moved.ts', content: 'engine' }];

    expect(hashEngineFiles(renamed)).not.toBe(hashEngineFiles(base));
  });

  it('changes when an engine file is added or removed', () => {
    const base = [{ path: 'a.ts', content: 'alpha' }];
    const grown = [
      { path: 'a.ts', content: 'alpha' },
      { path: 'b.ts', content: 'beta' },
    ];

    expect(hashEngineFiles(grown)).not.toBe(hashEngineFiles(base));
  });

  it('returns a lowercase hex sha256 digest', () => {
    expect(hashEngineFiles([{ path: 'a.ts', content: 'alpha' }])).toMatch(/^[0-9a-f]{64}$/);
  });
});
