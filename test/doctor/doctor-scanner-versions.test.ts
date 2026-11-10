/**
 * Doctor's browser report also says when a scanner version cannot be read. Such a version makes
 * every run not covered with no receipt, so doctor names it with the same fix the run's gap names.
 */
import { describe, expect, it } from 'vitest';
import type { ScannerVersions } from '../../src/contracts/index.js';
import { collectDoctorReport, type DoctorDeps, type SurfaceReport } from '../../src/doctor/index.js';
import { scannerVersionFix } from '../../src/evidence/receipt.js';
import type { InstallFs } from '../../src/install/index.js';

const READABLE: ScannerVersions = { axeCore: '4.13.0', playwright: '1.62.1', chromium: '151.0.7922.34' };

const emptyFs: InstallFs = {
  readFile: async () => null,
  glob: async () => [],
  writeFile: async () => {
    throw new Error('doctor must never write');
  },
};

function deps(extra: Partial<DoctorDeps>): DoctorDeps {
  return {
    fs: emptyFs,
    gh: { getJson: async () => null },
    configPath: 'usabl.config.json',
    env: {},
    probePlaywrightChromium: async () => 'wired',
    probeChromiumSandbox: async () => 'available',
    ...extra,
  };
}

async function browserReport(extra: Partial<DoctorDeps>): Promise<SurfaceReport> {
  const reports = await collectDoctorReport(deps(extra));
  const found = reports.find((report) => report.id === 'playwright-chromium');
  if (found === undefined) throw new Error('no playwright-chromium report');
  return found;
}

describe('doctor and scanner versions', () => {
  it('reports wired when Chromium is installed and every version reads', async () => {
    const report = await browserReport({ readScannerVersions: async () => READABLE });
    expect(report.state).toBe('wired');
    expect(report.nextStep).toBe('');
  });

  it('reports an unreadable Chromium version with the fix the run names', async () => {
    const report = await browserReport({ readScannerVersions: async () => ({ ...READABLE, chromium: 'unknown' }) });
    expect(report.state).toBe('drifted');
    expect(report.nextStep).toContain('could not read the version of Chromium');
    expect(report.nextStep).toContain('not covered');
    expect(report.nextStep).toContain(scannerVersionFix(['Chromium']));
  });

  it('reports unreadable package versions with the package fix', async () => {
    const report = await browserReport({
      readScannerVersions: async () => ({ ...READABLE, axeCore: 'unknown', playwright: 'unknown' }),
    });
    expect(report.state).toBe('drifted');
    expect(report.nextStep).toContain('axe-core and Playwright');
    expect(report.nextStep).toContain(scannerVersionFix(['axe-core', 'Playwright']));
  });

  it('keeps a missing Chromium as missing, since installing it comes first', async () => {
    const report = await browserReport({
      probePlaywrightChromium: async () => 'missing',
      readScannerVersions: async () => ({ ...READABLE, chromium: 'unknown' }),
    });
    expect(report.state).toBe('missing');
  });
});
