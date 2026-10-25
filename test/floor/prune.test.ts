import { describe, expect, it, vi } from 'vitest';
import type { Draft, EvidenceFloor, ScreenScan, UsablConfig } from '../../src/contracts/index.js';
import { main } from '../../src/cli.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { runFloorPrune } from '../../src/floor/prune.js';
import { groupByScreen } from '../../src/floor/unconfirmed.js';
import { computeIdentity } from '../../src/primitives/identity.js';
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
    applicability: [],
    reachedSelectorPresent: null,
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
      // The screen declares a readiness signal and it held, so the run shows the search field's
      // part of the page rendered and its absence is a pay-down.
      scans: { clusters: { ...scanWith([draft()]), reachedSelectorPresent: true } },
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
      scans: { clusters: { ...scanWith([]), reachedSelectorPresent: true } },
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

/**
 * Prune re-arms the floor, and until now it only did half of that.
 *
 * It dropped entries whose identity had vanished, but it left the recorded count alone on every
 * entry that survived. Because `usabl baseline` is the only thing that writes a count and it only
 * ever writes what it saw, the count became a high-water mark: pay down one of three barriers at a
 * collapsed identity and the floor kept claiming three forever. The gate then had headroom it could
 * not account for, and now reports it as a coverage gap telling the reader to run this command. The
 * command has to actually close it.
 */
describe('runFloorPrune lowers counts', () => {
  // Two barriers on different nodes that collapse to one name identity, so the count is the only
  // thing that separates one accepted barrier from two.
  const collapsing = (path: string): Draft => draft({ elementPath: path });

  const floorAtCount = (count: number, version: 1 | 2 = 2): string =>
    JSON.stringify({
      version,
      entries: [{
        screenId: 'clusters', layer: 'axe', rule: 'color-contrast',
        elementKey: 'clusters|color-contrast|name:save', identityBasis: 'name', count,
      }],
    });

  it('lowers a surviving entry to the count this run observed', async () => {
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': floorAtCount(3) }),
      scans: { clusters: scanWith([collapsing('button'), collapsing('footer button')]) },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, testConfig(), writer);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.wrote).toBe(true);
    // The identity is still there, so nothing is removed. The re-arming is the count coming down.
    expect(outcome.prunedCount).toBe(0);
    expect(outcome.loweredCount).toBe(1);
    expect(parseWrittenFloor(writer).entries[0]!.count).toBe(2);
    // A floor diff was written, so the message must not report zero work over it.
    expect(outcome.message).toContain('lowered the barrier count on 1 entry');
    expect(outcome.message).not.toContain('removed 0');
  });

  it('never raises a count, because accepting new debt is the baseline command with review', async () => {
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': floorAtCount(1) }),
      scans: { clusters: scanWith([collapsing('button'), collapsing('footer button')]) },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, testConfig(), writer);

    // Two barriers stand where the floor accepted one. The gate calls that a regression; prune
    // silently writing 2 here would launder it into accepted debt with no review.
    expect(outcome.wrote).toBe(false);
    expect(outcome.loweredCount).toBe(0);
    expect(writer.writes).toHaveLength(0);
  });

  it('leaves a version 1 count alone, because the file still says it is a placeholder', async () => {
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': floorAtCount(3, 1) }),
      scans: { clusters: scanWith([collapsing('button')]) },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, testConfig(), writer);

    // A version 1 name entry records a placeholder, not an observation, and the gate ignores it.
    // Writing a real number under a version that says otherwise would present it as observed debt.
    // `usabl baseline` is what moves a floor to version 2.
    expect(outcome.loweredCount).toBe(0);
    expect(outcome.wrote).toBe(false);
  });

  it('does not lower a count on a screen it did not cleanly scan', async () => {
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': floorAtCount(3) }),
      scans: {
        clusters: scanWith([collapsing('button')], [
          { ref: 'clusters', state: 'not-covered', reason: 'provider pf-rulepack failed: boom' },
        ]),
      },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, testConfig(), writer);

    // A gapped scan yields fewer drafts than the screen holds, so its tally is not a measurement.
    // Lowering on it would re-arm the gate against barriers that are still there.
    expect(outcome.loweredCount).toBe(0);
    expect(outcome.wrote).toBe(false);
  });
});

/**
 * Prune and the gate read one rule for what counts as paid down. An absent floored barrier is
 * fixed only when the run shows its part of the page rendered: the screen's reachedWhen signal
 * held, or the run met the barrier's own element. A screen whose header mounted and whose content
 * did not is scanned cleanly and shows every barrier in the content as absent, so without that rule
 * prune deleted real debt from the floor.
 */
describe('runFloorPrune keeps barriers it cannot confirm were fixed', () => {
  const searchEntry = {
    screenId: 'clusters', layer: 'axe', rule: 'aria-input-field-name',
    elementKey: 'clusters|aria-input-field-name|name:search', identityBasis: 'name' as const, count: 2,
  };
  const saveEntry = {
    screenId: 'clusters', layer: 'axe', rule: 'color-contrast',
    elementKey: 'clusters|color-contrast|name:save', identityBasis: 'name' as const, count: 1,
  };
  const floorOf = (...entries: EvidenceFloor['entries']): string => JSON.stringify({ version: 2, entries });
  // The Save barrier is still there, so the screen rendered something. Nothing shows the search
  // field's part of the page did.
  const chromeOnly = (over: Partial<ScreenScan> = {}): ScreenScan => ({ ...scanWith([draft()]), ...over });

  it('keeps an absent entry with no render evidence, writes nothing, and says why and what to do', async () => {
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': floorOf(saveEntry, searchEntry) }),
      scans: { clusters: chromeOnly() },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, testConfig(), writer);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.wrote).toBe(false);
    expect(outcome.prunedCount).toBe(0);
    expect(outcome.keptUnconfirmedCount).toBe(1);
    expect(writer.writes).toHaveLength(0);
    expect(outcome.message).toContain(
      'kept 1 floor entry (2 barriers) on screen clusters (aria-input-field-name) that this run did not see',
    );
    expect(outcome.message).toContain('add a reachedWhen signal for this screen or run usabl floor prune --unconfirmed');
    expect(outcome.message).not.toContain('name:search');
  });

  it('removes it with --unconfirmed and says how many it removed and why', async () => {
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': floorOf(saveEntry, searchEntry) }),
      scans: { clusters: chromeOnly() },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, testConfig(), writer, { unconfirmed: true });

    expect(outcome.wrote).toBe(true);
    expect(outcome.prunedCount).toBe(1);
    expect(outcome.removedUnconfirmedCount).toBe(1);
    expect(outcome.keptUnconfirmedCount).toBe(0);
    expect(parseWrittenFloor(writer).entries).toEqual([saveEntry]);
    expect(outcome.message).toContain('removed 1 floor entry in .usabl-evidence.json');
    expect(outcome.message).toContain(
      '1 of them (2 barriers) on screen clusters was removed because you passed --unconfirmed: ' +
        'this run did not see it and cannot show that part of the page rendered.',
    );
  });

  it('removes it without the flag when the screen signal held', async () => {
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': floorOf(saveEntry, searchEntry) }),
      scans: { clusters: chromeOnly({ reachedSelectorPresent: true }) },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, testConfig(), writer);

    expect(outcome.prunedCount).toBe(1);
    expect(outcome.keptUnconfirmedCount).toBe(0);
    expect(outcome.removedUnconfirmedCount).toBe(0);
    expect(parseWrittenFloor(writer).entries).toEqual([saveEntry]);
    expect(outcome.message).not.toContain('--unconfirmed');
  });

  it('removes it without the flag when the walk met its element', async () => {
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': floorOf(saveEntry, searchEntry) }),
      scans: {
        clusters: chromeOnly({
          stops: [{ index: 0, elementPath: 'input#search', announcement: [{ kind: 'name', text: 'Search', fromTree: true, source: 'ax-tree' }] }],
        }),
      },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, testConfig(), writer);

    expect(outcome.prunedCount).toBe(1);
    expect(outcome.keptUnconfirmedCount).toBe(0);
  });

  it('does not claim it kept entries on unscanned screens when it kept none', async () => {
    // An unmapped UI file leaves coverage incomplete, but every floor entry is on a screen that
    // was scanned cleanly. The old message said entries on unscanned screens were kept anyway.
    const deps = makeFakeDeps({
      ...withPolicyFiles({
        '.usabl-evidence.json': floorOf(saveEntry, searchEntry),
        'fixtures/app/src/Orphan.tsx': 'export {};\n',
      }),
      scans: { clusters: chromeOnly({ reachedSelectorPresent: true }) },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, testConfig(), writer);

    expect(outcome.prunedCount).toBe(1);
    expect(outcome.message).not.toContain('were kept');
    expect(outcome.message).not.toContain('kept');
  });

  it('names the entries it kept on screens it did not scan cleanly', async () => {
    const settingsEntry = { ...saveEntry, screenId: 'settings', elementKey: 'settings|color-contrast|name:save' };
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': floorOf(saveEntry, searchEntry, settingsEntry) }),
      scans: { clusters: chromeOnly({ reachedSelectorPresent: true }) },
    });
    const writer = new MemoryFloorFs();

    const outcome = await runFloorPrune(deps, testConfig(), writer);

    expect(outcome.prunedCount).toBe(1);
    expect(outcome.message).toContain('kept 1 floor entry on screens this run did not scan cleanly.');
  });
});

describe('runFloorPrune round two', () => {
  it('redacts a token-shaped screen id and rule in what it prints', async () => {
    const id = 'orders?token=SECRETPOISON';
    const entry = { screenId: id, layer: 'axe', rule: 'rule-token=SECRETPOISONRULE', elementKey: null, identityBasis: 'count' as const, count: 1 };
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': JSON.stringify({ version: 2, entries: [entry] }) }),
      scans: { [id]: { ...scanWith([]), screenId: id } },
    });
    const config = testConfig({ surfaces: [{ id, url: 'http://127.0.0.1:5173/orders', files: ['fixtures/app/src/ClustersPage.tsx'] }] });

    for (const unconfirmed of [false, true]) {
      const outcome = await runFloorPrune(deps, config, new MemoryFloorFs(), { unconfirmed });
      expect(outcome.message).toContain('[REDACTED]');
      expect(outcome.message).not.toContain('SECRETPOISON');
    }
  });

  it('scans docs pages too, so a docs entry can be confirmed or removed on purpose', async () => {
    const manifest = JSON.stringify({
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://localhost:8080/docs',
      builtRoot: 'build/html',
      buildCommand: null,
      pages: [{ pageId: 'install-guide', url: '/install.html', assemblyFile: 'modules/install.adoc', sources: ['modules/install.adoc'] }],
      sharedGlobs: [],
    });
    const fixedDraft = draft({ screenId: 'install-guide', layer: 'docs-axe', rule: 'image-alt', elementPath: 'img', elementName: null, role: null, evidence: {} });
    const entry = { screenId: 'install-guide', layer: 'docs-axe', rule: 'image-alt', ...computeIdentity(fixedDraft), count: 1 };
    const files = {
      'usabl.config.json': '{}',
      'usabl.docs.json': manifest,
      'modules/install.adoc': '= Install\n',
      '.usabl-evidence.json': JSON.stringify({ version: 2, entries: [entry] }),
    };
    const deps = makeFakeDeps({
      files,
      headContents: files,
      scans: { 'install-guide': { ...scanWith([]), screenId: 'install-guide', url: 'http://localhost:8080/docs/install.html' } },
    });
    const config = testConfig({ surfaces: [], guardedPaths: ['usabl.config.json', 'usabl.docs.json'] });

    const kept = await runFloorPrune(deps, config, new MemoryFloorFs());
    expect(kept.keptUnconfirmedCount).toBe(1);

    const writer = new MemoryFloorFs();
    const removed = await runFloorPrune(deps, config, writer, { unconfirmed: true });
    expect(removed.prunedCount).toBe(1);
    expect(parseWrittenFloor(writer).entries).toEqual([]);
  });

  it('reads an identity with only an advisory draft left the way the gate does', async () => {
    const entry = { screenId: 'clusters', layer: 'axe', rule: 'button-name', elementKey: null, identityBasis: 'count' as const, count: 2 };
    const deps = makeFakeDeps({
      ...withPolicyFiles({ '.usabl-evidence.json': JSON.stringify({ version: 2, entries: [entry] }) }),
      scans: { clusters: scanWith([draft({ rule: 'button-name', evidenceClass: 'preview', confidence: 'unverified' })]) },
    });

    const outcome = await runFloorPrune(deps, testConfig(), new MemoryFloorFs());

    expect(outcome.keptUnconfirmedCount).toBe(1);
    expect(outcome.wrote).toBe(false);
  });

  it('adds barriers per screen in an order that does not depend on the floor', () => {
    const entries = [Number.MAX_SAFE_INTEGER, 2, 1].map((count, index) => ({
      screenId: 'orders', layer: 'axe', rule: 'link-name', elementKey: `orders|link-name|struct:link:#row${index}`,
      identityBasis: 'structural' as const, count,
    }));
    expect(groupByScreen([...entries].reverse())).toEqual(groupByScreen(entries));
  });
});

describe('floor prune --unconfirmed parsing', () => {
  it('parses the flag', () => {
    expect(parseCliArgs(['floor', 'prune', '--unconfirmed']).unconfirmed).toBe(true);
    expect(parseCliArgs(['floor', 'prune']).unconfirmed).toBe(false);
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
