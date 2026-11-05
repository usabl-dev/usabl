/**
 * Doctor's engines section: each engine is off, or on with whether its package resolves the way the
 * run's import resolves it, whether its credentials are set, and whether a switch outside the
 * trusted config would make the run refuse. Credential values never appear. The section always says
 * what testing the engine support has had. Doctor still exits 0 and the engines never move the
 * surface counts.
 */
import { describe, expect, it } from 'vitest';
import type { InstallFs } from '../../src/install/index.js';
import { collectEngineReports, ENGINE_DISCLOSURE } from '../../src/doctor/engines.js';
import { runDoctor, type DoctorDeps } from '../../src/doctor/index.js';
import type { InstalledPackage } from '../../src/providers/engines/shared.js';
import { testConfig } from '../helpers.js';

const TOKEN = 'tok-77aa-fake-offline-token';
const SERVICE = 'svc-88bb-fake-service-id';
const API_KEY = 'key-99cc-fake-online-secret';

const NOT_INSTALLED = async (): Promise<InstalledPackage> => ({ state: 'not-installed' });
const INSTALLED = async (): Promise<InstalledPackage> => ({ state: 'installed', version: '1.0.0', missingDependencies: [] });

function filesFs(files: Record<string, string>): InstallFs {
  return {
    readFile: async (path) => files[path] ?? null,
    glob: async () => [],
    writeFile: async () => {
      throw new Error('doctor must never write');
    },
  };
}

function configWith(engines: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...testConfig(), ...extra, engines });
}

function deps(files: Record<string, string>, extra: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    fs: filesFs(files),
    gh: { getJson: async () => null },
    configPath: 'usabl.config.json',
    env: {},
    probePlaywrightChromium: async () => 'wired',
    probeChromiumSandbox: async () => 'available',
    probeEnginePackage: NOT_INSTALLED,
    ...extra,
  };
}

function engineLines(stdout: string): string[] {
  const start = stdout.indexOf('optional engines');
  return stdout.slice(start).trimEnd().split('\n');
}

describe('usabl doctor engines section', () => {
  it('says plainly what testing the engine support has had', () => {
    expect(ENGINE_DISCLOSURE).toBe(
      "Tested against the vendor's documented result format. Not yet run on a licensed SDK. Engine findings are preview: shown, never blocking.",
    );
  });

  it('shows both engines off when the config has no engines block, with the disclosure', async () => {
    const outcome = await runDoctor(deps({ 'usabl.config.json': JSON.stringify(testConfig()) }));
    expect(outcome.exitCode).toBe(0);
    const lines = engineLines(outcome.stdout);
    expect(lines[0]).toBe('optional engines (engines in the usabl config):');
    expect(lines[1]).toBe(`  ${ENGINE_DISCLOSURE}`);
    expect(lines[2]).toBe('  [off] deque (axe DevTools for Web, @axe-devtools/playwright)');
    expect(lines[3]).toContain('set engines.deque.enabled to true in usabl.config.json');
    expect(lines[4]).toBe('  [off] evinced (Evinced Automation for Web, @evinced/js-playwright-sdk)');
  });

  it('does not change the surface counts in the header', async () => {
    const off = await runDoctor(deps({ 'usabl.config.json': JSON.stringify(testConfig()) }));
    const on = await runDoctor(
      deps({ 'usabl.config.json': configWith({ deque: { enabled: true }, evinced: { enabled: true } }) }),
    );
    expect(on.stdout.split('\n')[0]).toBe(off.stdout.split('\n')[0]);
  });

  it('shows an engine that is on with its package and credentials state', async () => {
    const reports = await collectEngineReports({
      readFile: async (path) =>
        path === 'usabl.config.json' ? configWith({ deque: { enabled: true }, evinced: { enabled: true } }) : null,
      configPath: 'usabl.config.json',
      env: { EVINCED_SERVICE_ID: SERVICE },
      probePackage: async (name) =>
        name === '@evinced/js-playwright-sdk'
          ? { state: 'installed', version: '3.9.0', missingDependencies: [] }
          : { state: 'not-installed' },
    });
    expect(reports.map((r) => [r.id, r.state])).toEqual([
      ['deque', 'on, package not installed, credentials: none needed'],
      ['evinced', 'on, package 3.9.0, credentials present: no'],
    ]);
    expect(reports[1]?.note).toBe(
      'Set EVINCED_AUTH_TOKEN (offline mode reads EVINCED_SERVICE_ID and EVINCED_AUTH_TOKEN). Or set engines.evinced.enabled to false. Until then every scan notes that this engine did not run.',
    );
  });

  it('names a dependency the vendor package needs that is not installed', async () => {
    const reports = await collectEngineReports({
      readFile: async (path) => (path === 'usabl.config.json' ? configWith({ deque: { enabled: true } }) : null),
      configPath: 'usabl.config.json',
      env: { AXE_TRACK_USAGE: 'false' },
      probePackage: async () => ({ state: 'installed', version: '4.11.2', missingDependencies: ['axe-core-pro'] }),
    });
    expect(reports[0]?.state).toBe('on, package 4.11.2 (missing axe-core-pro), credentials: none needed');
    expect(reports[0]?.note).toContain('axe-core-pro, a package @axe-devtools/playwright needs, is not installed');
  });

  it('prints the state, and never a credential value', async () => {
    const outcome = await runDoctor(
      deps(
        { 'usabl.config.json': configWith({ deque: { enabled: true }, evinced: { enabled: true, mode: 'online' } }) },
        {
          env: { EVINCED_SERVICE_ID: SERVICE, EVINCED_API_KEY: API_KEY, EVINCED_AUTH_TOKEN: TOKEN, AXE_TRACK_USAGE: 'false' },
          probeEnginePackage: INSTALLED,
        },
      ),
    );
    const lines = engineLines(outcome.stdout);
    expect(lines[2]).toBe(
      '  [on, package 1.0.0, credentials: none needed] deque (axe DevTools for Web, @axe-devtools/playwright)',
    );
    expect(lines[3]).toBe('      Usage tracking off. No credentials are needed at run time.');
    expect(lines[4]).toBe(
      '  [on, package 1.0.0, credentials present: yes] evinced (Evinced Automation for Web, @evinced/js-playwright-sdk)',
    );
    expect(lines[5]).toBe('      Online mode contacts the Evinced license server. Credential values are never printed.');
    for (const secret of [TOKEN, SERVICE, API_KEY]) {
      expect(outcome.stdout).not.toContain(secret);
    }
  });

  it('warns that every scan will refuse Deque until AXE_TRACK_USAGE is false', async () => {
    const reports = await collectEngineReports({
      readFile: async (path) => (path === 'usabl.config.json' ? configWith({ deque: { enabled: true } }) : null),
      configPath: 'usabl.config.json',
      env: {},
      probePackage: INSTALLED,
    });
    expect(reports[0]?.note).toBe(
      'Every scan will refuse to run Deque until this is fixed: AXE_TRACK_USAGE is not set to false. Set AXE_TRACK_USAGE=false, which turns Deque usage reporting off while the package loads, or opt in with engines.deque.trackUsage.',
    );
  });

  it('needs no AXE_TRACK_USAGE when the operator opts in to usage tracking', async () => {
    const reports = await collectEngineReports({
      readFile: async (path) => (path === 'usabl.config.json' ? configWith({ deque: { enabled: true, trackUsage: true } }) : null),
      configPath: 'usabl.config.json',
      env: {},
      probePackage: INSTALLED,
    });
    expect(reports[0]?.note).toBe(
      'Usage tracking on (opted in), so Deque sends usage data to its usage service. No credentials are needed at run time.',
    );
  });

  it('warns about every switch outside the trusted config that would make a scan refuse', async () => {
    const reports = await collectEngineReports({
      readFile: async (path) =>
        ({
          'usabl.config.json': configWith({ deque: { enabled: true }, evinced: { enabled: true } }),
          'axe-ruleset.json': '{}',
          'evConfig.yml': 'switchOn: false',
        })[path] ?? null,
      configPath: 'usabl.config.json',
      env: {
        AXE_TRACK_USAGE: 'true',
        AXE_RULESET_PATH: '/secret/path.json',
        EV_SWITCH_ON: 'false',
        EVINCED_SERVICE_ID: SERVICE,
        EVINCED_AUTH_TOKEN: TOKEN,
      },
      probePackage: INSTALLED,
    });
    expect(reports[0]?.note).toBe(
      'Every scan will refuse to run Deque until this is fixed: AXE_TRACK_USAGE is not set to false; AXE_RULESET_PATH is set; axe-ruleset.json is in the project and not in guardedPaths. Set AXE_TRACK_USAGE=false, which turns Deque usage reporting off while the package loads, or opt in with engines.deque.trackUsage.',
    );
    expect(reports[1]?.note).toBe(
      'Every scan will refuse to run Evinced until this is fixed: EV_SWITCH_ON is set to a value other than true; evConfig.yml is in the project and not in guardedPaths.',
    );
    expect(JSON.stringify(reports)).not.toContain('/secret/path.json');
  });

  it('does not warn about a switch file listed in guardedPaths', async () => {
    const reports = await collectEngineReports({
      readFile: async (path) =>
        ({
          'usabl.config.json': configWith({ evinced: { enabled: true } }, { guardedPaths: ['usabl.config.json', 'evConfig.json'] }),
          'evConfig.json': '{}',
        })[path] ?? null,
      configPath: 'usabl.config.json',
      env: { EVINCED_SERVICE_ID: SERVICE, EVINCED_AUTH_TOKEN: TOKEN },
      probePackage: INSTALLED,
    });
    expect(reports[1]?.note).toBe('Offline mode needs no license server. Credential values are never printed.');
  });

  it('says unknown when the config does not parse, and still exits 0', async () => {
    const outcome = await runDoctor(deps({ 'usabl.config.json': configWith({ deque: { enabeld: true } }) }));
    expect(outcome.exitCode).toBe(0);
    const lines = engineLines(outcome.stdout);
    expect(lines[2]).toBe('  [unknown] deque (axe DevTools for Web, @axe-devtools/playwright)');
    expect(lines[3]).toContain('could not read the engines block from usabl.config.json');
  });

  it('says unknown when the config cannot be read', async () => {
    const reports = await collectEngineReports({
      readFile: async () => {
        throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      },
      configPath: 'usabl.config.json',
      env: {},
    });
    expect(reports.map((r) => r.state)).toEqual(['unknown', 'unknown']);
  });
});
