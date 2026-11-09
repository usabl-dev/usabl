/**
 * `usabl verify sensitivity` with its browser work replaced by fixed measurements: what it writes,
 * what it prints, when it exits nonzero, and that the attestation is deterministic and scrubbed.
 * It measures and never judges, so a run with missed entries still exits 0.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../../src/cli.js';
import type { UsablConfig } from '../../../src/contracts/index.js';
import { buildAttestation, serializeAttestation } from '../../../src/measure/sensitivity/attestation.js';
import { SENSITIVITY_CATALOG } from '../../../src/measure/sensitivity/catalog.js';
import { runVerifySensitivity, type VerifySensitivityPorts } from '../../../src/measure/sensitivity/command.js';
import { LEVEL1_SCREEN_IDS } from '../../../src/measure/sensitivity/level1.js';
import type { EntryMeasurement } from '../../../src/measure/sensitivity/runner.js';
import { parseCliArgs } from '../../../src/surfaces/cli.js';
import { testConfig } from '../../helpers.js';

const VERSIONS = {
  runnerVersion: '0.3.0+abc',
  scannerVersions: { axeCore: '4.13.0', playwright: '1.62.1', chromium: 'revision-1' },
};

function level1(): EntryMeasurement[] {
  return SENSITIVITY_CATALOG.map((entry): EntryMeasurement => {
    if (entry.id === 'control-out-of-tab-order') {
      return { entry: entry.id, screen: entry.level1Screen, outcome: 'missed', rules: [], reason: 'nothing new gated; no shipped rule claims this defect' };
    }
    if (entry.id === 'docs-heading-level-skipped') {
      return { entry: entry.id, screen: entry.level1Screen, outcome: 'not applicable', rules: [], reason: 'no element on the page matches the target selector' };
    }
    return { entry: entry.id, screen: entry.level1Screen, outcome: 'caught', rules: [...entry.expectedRules].slice(0, 1), reason: null };
  });
}

interface Captured {
  out: string[];
  err: string[];
  files: Record<string, string>;
  level2Calls: number;
}

function ports(overrides: Partial<VerifySensitivityPorts> = {}, config: UsablConfig = testConfig()): { ports: VerifySensitivityPorts; captured: Captured } {
  const captured: Captured = { out: [], err: [], files: {}, level2Calls: 0 };
  return {
    captured,
    ports: {
      now: () => '2026-11-09T12:00:00.000Z',
      versions: async () => VERSIONS,
      level1: async () => level1(),
      loadConfig: async () => config,
      level2: async (_config, screens) => {
        captured.level2Calls += 1;
        return screens.map((screen) => ({ entry: 'button-name-removed', screen: screen.id, outcome: 'caught', rules: ['button-name'], reason: null }));
      },
      writeAttestation: async (path, text) => {
        captured.files[path] = text;
      },
      stdout: (text) => void captured.out.push(text),
      stderr: (text) => void captured.err.push(text),
      ...overrides,
    },
  };
}

const OPTIONS = { app: false, screens: null, json: false };

describe('runVerifySensitivity', () => {
  it('writes the attestation and exits 0 even though an entry was missed', async () => {
    const { ports: io, captured } = ports();
    expect(await runVerifySensitivity(OPTIONS, io)).toBe(0);
    const file = captured.files['.usabl/sensitivity.json'];
    expect(file).toBeDefined();
    const attestation = JSON.parse(file ?? '{}');
    expect(attestation.schemaVersion).toBe('usabl.sensitivity.v1');
    expect(attestation.date).toBe('2026-11-09T12:00:00.000Z');
    expect(attestation.engineVersion).toBe('0.3.0+abc');
    expect(attestation.scannerVersions).toEqual(VERSIONS.scannerVersions);
    expect(attestation.catalog.entries).toBe(SENSITIVITY_CATALOG.length);
    expect(attestation.catalog.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(attestation.levels.app).toBeNull();
    expect(attestation.levels.fixture.screens).toEqual([...LEVEL1_SCREEN_IDS]);
    const total = SENSITIVITY_CATALOG.length;
    expect(attestation.levels.fixture.totals).toEqual({
      caught: total - 2,
      'caught by another rule': 0,
      missed: 1,
      'preview only': 0,
      'not applicable': 1,
      unreadable: 0,
    });
    expect(attestation.levels.fixture.measured).toBe(total - 1);
    const missed = attestation.levels.fixture.entries.find((entry: { entry: string }) => entry.entry === 'control-out-of-tab-order');
    expect(missed).toMatchObject({ outcome: 'missed', screen: 'sensitivity-basic', criterion: '2.1.1 Keyboard', reason: 'nothing new gated; no shipped rule claims this defect' });
  });

  it('prints what was measured, with N and M, and every missed entry by name with what was expected', async () => {
    const { ports: io, captured } = ports();
    await runVerifySensitivity(OPTIONS, io);
    const out = captured.out.join('');
    const total = SENSITIVITY_CATALOG.length;
    expect(out).toContain(`On the fixture pages: caught ${total - 2} of ${total - 1} catalog defects.`);
    expect(out).toContain('  Missed:\n    control-out-of-tab-order on sensitivity-basic. Expected: no shipped rule. nothing new gated; no shipped rule claims this defect');
    expect(out).toContain('measurement only');
    expect(out).toContain('Wrote .usabl/sensitivity.json.');
    expect(out).not.toMatch(/%|detects all|complian|—|--/i);
  });

  it('reports a run where nothing applied as measuring nothing, not as a pass', async () => {
    const { ports: io, captured } = ports({
      level1: async () =>
        SENSITIVITY_CATALOG.map((entry) => ({ entry: entry.id, screen: entry.level1Screen, outcome: 'not applicable' as const, rules: [], reason: 'no element on the page matches the target selector' })),
    });
    expect(await runVerifySensitivity(OPTIONS, io)).toBe(0);
    expect(captured.out.join('')).toContain('On the fixture pages: measured nothing. No catalog defect could be made and read on these screens, so this is not a pass.');
  });

  it('exits 4 and writes nothing when it could not run', async () => {
    const { ports: io, captured } = ports({
      level1: async () => {
        throw new Error('Chromium could not start');
      },
    });
    expect(await runVerifySensitivity(OPTIONS, io)).toBe(4);
    expect(captured.files).toEqual({});
    expect(captured.err.join('')).toContain('verify sensitivity could not run, so no attestation was written: Chromium could not start');
  });

  it('refuses --screen without --app', async () => {
    const { ports: io, captured } = ports();
    expect(await runVerifySensitivity({ ...OPTIONS, screens: ['clusters'] }, io)).toBe(2);
    expect(captured.err.join('')).toContain('--screen picks app screens, so it needs --app');
    expect(captured.files).toEqual({});
  });

  it('refuses --app when the config cannot be read, or a screen id is not a surface', async () => {
    const unreadable = ports({ loadConfig: async () => Promise.reject(new Error('usabl.config.json not found.')) });
    expect(await runVerifySensitivity({ ...OPTIONS, app: true }, unreadable.ports)).toBe(2);
    expect(unreadable.captured.err.join('')).toContain('usabl.config.json not found.');

    const unknown = ports();
    expect(await runVerifySensitivity({ ...OPTIONS, app: true, screens: ['nowhere'] }, unknown.ports)).toBe(2);
    expect(unknown.captured.err.join('')).toContain('no surface in usabl.config.json has the id nowhere');
    expect(unknown.captured.level2Calls).toBe(0);
  });

  it('runs the app level only with --app, says it loads each screen many times, and keeps the levels apart', async () => {
    const config = testConfig({
      surfaces: [
        { id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: [] },
        { id: 'settings', url: 'http://127.0.0.1:5173/settings', files: [] },
      ],
    });
    const { ports: io, captured } = ports({}, config);
    expect(await runVerifySensitivity({ ...OPTIONS, app: true, screens: ['settings'] }, io)).toBe(0);
    expect(captured.level2Calls).toBe(1);
    expect(captured.err.join('')).toContain(`loads each of 1 app screen(s) twice for every catalog entry, up to ${SENSITIVITY_CATALOG.length * 2} page loads`);
    const attestation = JSON.parse(captured.files['.usabl/sensitivity.json'] ?? '{}');
    expect(attestation.levels.app.screens).toEqual(['settings']);
    expect(attestation.levels.app.entries).toHaveLength(1);
    expect(attestation.levels.fixture.entries).toHaveLength(SENSITIVITY_CATALOG.length);
    expect(captured.out.join('')).toContain('On the app screens: caught 1 of 1 catalog defects.');
  });

  it('prints the attestation itself with --json', async () => {
    const { ports: io, captured } = ports();
    await runVerifySensitivity({ ...OPTIONS, json: true }, io);
    expect(captured.out.join('')).toBe(captured.files['.usabl/sensitivity.json']);
  });
});

describe('the attestation', () => {
  function bytes(date: string, measurements: EntryMeasurement[]): string {
    return serializeAttestation(
      buildAttestation({
        date,
        engineVersion: VERSIONS.runnerVersion,
        scannerVersions: VERSIONS.scannerVersions,
        fixture: { screens: [...LEVEL1_SCREEN_IDS].reverse(), measurements },
        app: null,
      }),
    );
  }

  it('is byte-identical for the same inputs in any order, apart from the date', () => {
    const forward = bytes('2026-11-09T12:00:00.000Z', level1());
    const reversed = bytes('2026-11-10T08:30:00.000Z', [...level1()].reverse());
    expect(reversed.replace('2026-11-10T08:30:00.000Z', '2026-11-09T12:00:00.000Z')).toBe(forward);
    expect(bytes('2026-11-09T12:00:00.000Z', level1())).toBe(forward);
  });

  it('lists every shipped rule the catalog does not exercise, each with a reason', () => {
    const attestation = JSON.parse(bytes('2026-11-09T12:00:00.000Z', level1()));
    const rules = attestation.notExercised.map((entry: { rule: string }) => entry.rule);
    expect(rules).toContain('keyboard-walk-unconfirmed-focus');
    expect(rules).toContain('rhds-accordion-header-parent');
    expect(rules).not.toContain('button-name');
    for (const entry of attestation.notExercised) {
      expect(entry.reason.length, entry.rule).toBeGreaterThan(0);
    }
  });

  it('scrubs what it writes, so a credential in a gap reason never reaches the file', () => {
    const measurements: EntryMeasurement[] = [
      {
        entry: 'button-name-removed',
        screen: 'sensitivity-basic',
        outcome: 'unreadable',
        rules: [],
        reason: 'the clean scan had a coverage gap: nothing answered at http://user:hunter2@127.0.0.1:5173/basic?token=abc123secret',
      },
    ];
    const file = bytes('2026-11-09T12:00:00.000Z', measurements);
    expect(file).not.toContain('hunter2');
    expect(file).not.toContain('abc123secret');
    expect(file).toContain('nothing answered at http://127.0.0.1:5173/basic');
  });
});

describe('parsing usabl verify', () => {
  it('reads the subcommand, --app as a switch, and every --screen id', () => {
    const opts = parseCliArgs(['verify', 'sensitivity', '--app', '--screen', 'clusters', 'settings', '--json']);
    expect(opts).toMatchObject({ command: 'verify', verifySubcommand: 'sensitivity', verifyApp: true, screens: ['clusters', 'settings'], json: true });
    expect(opts.app).toBeUndefined();
  });

  it('keeps --app a folder for init', () => {
    expect(parseCliArgs(['init', '--app', 'packages/web'])).toMatchObject({ command: 'init', app: 'packages/web', verifyApp: false });
  });

  it('refuses --screen with no id', () => {
    expect(() => parseCliArgs(['verify', 'sensitivity', '--app', '--screen'])).toThrow('--screen requires at least one surface id');
  });
});

describe('usabl verify from the command line', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture(): string[] {
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return err;
  }

  it('refuses a missing or unknown subcommand before anything runs', async () => {
    const err = capture();
    expect(await main(['verify'])).toBe(2);
    expect(await main(['verify', 'speed'])).toBe(2);
    expect(err.join('')).toContain('verify has one subcommand: usabl verify sensitivity');
  });

  it('refuses --screen without --app before any browser opens', async () => {
    const err = capture();
    expect(await main(['verify', 'sensitivity', '--screen', 'clusters'])).toBe(2);
    expect(err.join('')).toContain('--screen picks app screens, so it needs --app');
  });
});
