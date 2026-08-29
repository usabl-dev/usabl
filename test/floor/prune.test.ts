import { describe, expect, it, vi } from 'vitest';
import type { Draft, EvidenceFloor, ScreenScan, UsablConfig } from '../../src/contracts/index.js';
import { main } from '../../src/cli.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { runFloorPrune } from '../../src/floor/prune.js';
import { parseCliArgs } from '../../src/surfaces/cli.js';
import { testConfig } from '../helpers.js';

class MemoryFloorFs {
  readonly writes: Array<{ path: string; contents: string }> = [];
  private readonly store = new Map<string, string>();

  async writeFile(path: string, contents: string): Promise<void> {
    this.writes.push({ path, contents });
    this.store.set(path, contents);
  }

  read(path: string): string | null {
    return this.store.get(path) ?? null;
  }
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    rule: 'color-contrast',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'clusters',
    elementPath: 'button',
    elementName: 'Save',
    role: 'button',
    whatUserExperiences: 'Button text is hard to read',
    why: 'Contrast is too low',
    fix: 'Raise contrast to 4.5:1',
    evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
    confidence: 'fail',
    ...overrides,
  };
}

function scanWith(drafts: Draft[], gaps: ScreenScan['gaps'] = []): ScreenScan {
  return {
    screenId: 'clusters',
    url: 'http://127.0.0.1:5173/clusters',
    stops: [],
    drafts,
    gaps,
  };
}

function withPolicyFiles(
  files: Record<string, string>,
  headContents: Record<string, string> = files,
): { files: Record<string, string>; headContents: Record<string, string> } {
  return {
    files: {
      'usabl.config.json': '{}',
      'fixtures/app/src/ClustersPage.tsx': 'export {};\n',
      ...files,
    },
    headContents: {
      'usabl.config.json': '{}',
      'fixtures/app/src/ClustersPage.tsx': 'export {};\n',
      ...headContents,
    },
  };
}

function floor(entries: EvidenceFloor['entries']): EvidenceFloor {
  return { version: 1, entries };
}

function parseWrittenFloor(writer: MemoryFloorFs): EvidenceFloor {
  const raw = writer.read('.usabl-evidence.json');
  if (raw === null) {
    throw new Error('expected .usabl-evidence.json to be written');
  }
  return JSON.parse(raw) as EvidenceFloor;
}

describe('runFloorPrune', () => {
  it('removes only paid-down entries and keeps still-present deterministic identities', async () => {
    const config = testConfig();
    const deps = makeFakeDeps({
      ...withPolicyFiles({
        '.usabl-evidence.json': JSON.stringify(
          floor([
            {
              screenId: 'clusters',
              layer: 'axe',
              rule: 'color-contrast',
              elementKey: 'clusters|color-contrast|name:save',
              identityBasis: 'name',
              count: 1,
            },
            {
              screenId: 'clusters',
              layer: 'axe',
              rule: 'aria-input-field-name',
              elementKey: 'clusters|aria-input-field-name|name:search',
              identityBasis: 'name',
              count: 1,
            },
          ]),
        ),
      }),
      scans: { clusters: scanWith([draft()]) },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, config, writer);
    const writtenFloor = parseWrittenFloor(writer);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.wrote).toBe(true);
    expect(outcome.prunedCount).toBe(1);
    expect(writtenFloor.entries).toEqual([
      {
        screenId: 'clusters',
        layer: 'axe',
        rule: 'color-contrast',
        elementKey: 'clusters|color-contrast|name:save',
        identityBasis: 'name',
        count: 1,
      },
    ]);
  });

  it('keeps entries for screens not in coverage.affected', async () => {
    const config = testConfig();
    const deps = makeFakeDeps({
      ...withPolicyFiles({
        '.usabl-evidence.json': JSON.stringify(
          floor([
            {
              screenId: 'settings',
              layer: 'axe',
              rule: 'color-contrast',
              elementKey: 'settings|color-contrast|name:save',
              identityBasis: 'name',
              count: 1,
            },
          ]),
        ),
      }),
      scans: { clusters: scanWith([]) },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, config, writer);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.wrote).toBe(false);
    expect(outcome.prunedCount).toBe(0);
    expect(writer.writes).toHaveLength(0);
  });

  it('keeps entries for an affected screen whose scan gapped instead of pruning them', async () => {
    const config = testConfig();
    const deps = makeFakeDeps({
      ...withPolicyFiles({
        '.usabl-evidence.json': JSON.stringify(
          floor([
            {
              screenId: 'clusters',
              layer: 'axe',
              rule: 'color-contrast',
              elementKey: 'clusters|color-contrast|name:save',
              identityBasis: 'name',
              count: 1,
            },
          ]),
        ),
      }),
      // The clusters screen is affected, but its scan failed (browser unavailable),
      // so it yields no drafts and a not-covered gap. Absence of the barrier here is
      // not proof it was fixed. Pruning it would re-arm the gate on debt that is still
      // present, forcing a false regression the next time the screen scans cleanly.
      scans: {
        clusters: scanWith(
          [],
          [{ ref: 'http://127.0.0.1:5173/clusters', state: 'not-covered', reason: 'browser unavailable' }],
        ),
      },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, config, writer);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.wrote).toBe(false);
    expect(outcome.prunedCount).toBe(0);
    expect(writer.writes).toHaveLength(0);
  });

  it('refuses when other guarded files are dirty', async () => {
    const config = testConfig();
    const deps = makeFakeDeps({
      ...withPolicyFiles(
        {
          'usabl.config.json': '{"appBaseUrl":"http://evil.test"}',
          '.usabl-evidence.json': JSON.stringify(floor([])),
        },
        {
          'usabl.config.json': '{}',
          '.usabl-evidence.json': JSON.stringify(floor([])),
          'fixtures/app/src/ClustersPage.tsx': 'export {};\n',
        },
      ),
      scans: { clusters: scanWith([draft()]) },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, config, writer);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.wrote).toBe(false);
    expect(writer.writes).toHaveLength(0);
    expect(outcome.message).toContain('guarded paths');
  });

  it('allows dirty floor bytes plus dirty UI files', async () => {
    const config = testConfig();
    const deps = makeFakeDeps({
      ...withPolicyFiles(
        {
          'fixtures/app/src/ClustersPage.tsx': 'export const changed = true;\n',
          '.usabl-evidence.json': JSON.stringify(
            floor([
              {
                screenId: 'clusters',
                layer: 'axe',
                rule: 'aria-input-field-name',
                elementKey: 'clusters|aria-input-field-name|name:search',
                identityBasis: 'name',
                count: 1,
              },
            ]),
          ),
        },
        {
          'fixtures/app/src/ClustersPage.tsx': 'export {};\n',
          '.usabl-evidence.json': JSON.stringify(floor([])),
          'usabl.config.json': '{}',
        },
      ),
      scans: { clusters: scanWith([]) },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, config, writer);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.wrote).toBe(true);
    expect(outcome.prunedCount).toBe(1);
    expect(writer.writes).toHaveLength(1);
  });

  it('refuses on crash and on nothingToCheck without writing', async () => {
    const crashConfig = testConfig();
    const crashDeps = makeFakeDeps({
      ...withPolicyFiles({
        '.usabl-evidence.json': JSON.stringify(
          floor([
            {
              screenId: 'clusters',
              layer: 'axe',
              rule: 'color-contrast',
              elementKey: 'clusters|color-contrast|name:save',
              identityBasis: 'name',
              count: 1,
            },
          ]),
        ),
      }),
      scans: { clusters: scanWith([draft()]) },
    });
    crashDeps.checkRunner.scan = async () => {
      throw new Error('browser disconnected');
    };
    const crashWriter = new MemoryFloorFs();

    const crash = await runFloorPrune(crashDeps, crashConfig, crashWriter);

    expect(crash.exitCode).toBe(4);
    expect(crash.wrote).toBe(false);
    expect(crashWriter.writes).toHaveLength(0);

    const noUiConfig: UsablConfig = testConfig({ uiFileGlobs: ['src/**/*.tsx'] });
    const noUiDeps = makeFakeDeps({
      ...withPolicyFiles({
        '.usabl-evidence.json': JSON.stringify(
          floor([
            {
              screenId: 'clusters',
              layer: 'axe',
              rule: 'color-contrast',
              elementKey: 'clusters|color-contrast|name:save',
              identityBasis: 'name',
              count: 1,
            },
          ]),
        ),
        README: '# docs\n',
      }),
      scans: { clusters: scanWith([draft()]) },
    });
    const noUiWriter = new MemoryFloorFs();

    const noUi = await runFloorPrune(noUiDeps, noUiConfig, noUiWriter);

    expect(noUi.exitCode).toBe(2);
    expect(noUi.wrote).toBe(false);
    expect(noUiWriter.writes).toHaveLength(0);
  });

  it('is a no-op when no floor entries are paid down', async () => {
    const config = testConfig();
    const deps = makeFakeDeps({
      ...withPolicyFiles({
        '.usabl-evidence.json': JSON.stringify(
          floor([
            {
              screenId: 'clusters',
              layer: 'axe',
              rule: 'color-contrast',
              elementKey: 'clusters|color-contrast|name:save',
              identityBasis: 'name',
              count: 1,
            },
          ]),
        ),
      }),
      scans: { clusters: scanWith([draft()]) },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, config, writer);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.wrote).toBe(false);
    expect(outcome.prunedCount).toBe(0);
    expect(writer.writes).toHaveLength(0);
  });
});

describe('floor command parsing', () => {
  it('parses floor prune and refuses floor without prune', async () => {
    const parsed = parseCliArgs(['floor', 'prune']);
    expect(parsed.command).toBe('floor');
    expect(parsed.floorSubcommand).toBe('prune');

    const stderr: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(
      ((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      }) as typeof process.stderr.write,
    );

    try {
      const exitCode = await main(['floor']);
      expect(exitCode).toBe(2);
      expect(stderr.join('')).toContain('floor supports only the prune subcommand');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
