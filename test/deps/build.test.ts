import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { buildDeps } from '../../src/deps/build.js';
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

    expect(deps.runnerVersion).toBe(packageVersion);
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
