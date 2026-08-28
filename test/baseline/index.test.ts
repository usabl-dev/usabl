import { describe, expect, it } from 'vitest';
import type { Draft, ScreenScan, UsablConfig, WaiverLedger } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { runBaseline } from '../../src/baseline/index.js';
import { testConfig } from '../helpers.js';

class MemoryBaselineFs {
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

function parseWrittenFloor(writer: MemoryBaselineFs): { version: 1; entries: Array<Record<string, unknown>> } {
  const raw = writer.read('.usabl-evidence.json');
  if (raw === null) {
    throw new Error('expected .usabl-evidence.json to be written');
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected floor JSON object');
  }
  const version = Reflect.get(parsed, 'version');
  const entries = Reflect.get(parsed, 'entries');
  if (version !== 1 || !Array.isArray(entries)) {
    throw new Error('expected floor shape');
  }
  const normalizedEntries = entries.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
  return { version: 1, entries: normalizedEntries };
}

describe('runBaseline', () => {
  it('copies deterministic identity fields and sets count=1 for name and structural findings', async () => {
    const config = testConfig();
    const deps = makeFakeDeps({
      ...withPolicyFiles({}),
      scans: {
        clusters: scanWith([
          draft({
            rule: 'color-contrast',
            layer: 'axe',
            evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
          }),
          draft({
            rule: 'pf-focus-into-dialog',
            layer: 'pf',
            evidence: {},
            elementName: null,
            role: 'dialog',
            elementPath: 'main > section:nth-child(2) > div:nth-of-type(3)',
          }),
        ]),
      },
    });
    const writer = new MemoryBaselineFs();

    const result = await runBaseline(deps, config, writer);
    const floor = parseWrittenFloor(writer);

    expect(result.exitCode).toBe(0);
    expect(floor.version).toBe(1);
    expect(floor.entries).toEqual([
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
        layer: 'pf',
        rule: 'pf-focus-into-dialog',
        elementKey: 'clusters|pf-focus-into-dialog|struct:dialog:main>section>div',
        identityBasis: 'structural',
        count: 1,
      },
    ]);
  });

  it('writes one count-basis entry with draft count for identity-weak rules', async () => {
    const config = testConfig();
    const deps = makeFakeDeps({
      ...withPolicyFiles({}),
      scans: {
        clusters: scanWith([
          draft({ rule: 'button-name', evidence: {}, elementName: null, role: null }),
          draft({
            rule: 'button-name',
            evidence: {},
            elementName: null,
            role: null,
            elementPath: 'main button:nth-child(2)',
          }),
        ]),
      },
    });
    const writer = new MemoryBaselineFs();

    const result = await runBaseline(deps, config, writer);
    const floor = parseWrittenFloor(writer);

    expect(result.exitCode).toBe(0);
    expect(floor.entries).toEqual([
      {
        screenId: 'clusters',
        layer: 'axe',
        rule: 'button-name',
        elementKey: null,
        identityBasis: 'count',
        count: 2,
      },
    ]);
  });

  it('excludes preview/model-judgment/fixed findings and keeps waived deterministic findings', async () => {
    const config = testConfig();
    const waivers: WaiverLedger = {
      version: 1,
      waivers: [
        {
          rule: 'button-name',
          surface: 'clusters',
          scope: '*',
          reason: 'Accepted debt for this release',
          owner: 'team',
          approvedBy: 'owner',
          created: '2026-01-01T00:00:00.000Z',
          expires: '2026-12-31T00:00:00.000Z',
        },
      ],
    };
    const deps = makeFakeDeps({
      ...withPolicyFiles(
        {
          '.usabl-waivers.json': JSON.stringify(waivers),
          '.usabl-evidence.json':
            '{"version":1,"entries":[{"screenId":"clusters","layer":"axe","rule":"pf-kebab-expanded-state","elementKey":"clusters|pf-kebab-expanded-state|name:menu","identityBasis":"name","count":1}]}',
        },
      ),
      scans: {
        clusters: scanWith([
          draft({ rule: 'button-name', evidence: {}, elementName: null, role: null }),
          draft({ rule: 'preview-only', evidenceClass: 'preview', confidence: 'unverified' }),
          draft({ rule: 'model-only', evidenceClass: 'model-judgment', confidence: 'unverified' }),
        ]),
      },
    });
    const writer = new MemoryBaselineFs();

    const result = await runBaseline(deps, config, writer);
    const floor = parseWrittenFloor(writer);

    expect(result.exitCode).toBe(0);
    expect(floor.entries).toHaveLength(1);
    expect(floor.entries[0]).toMatchObject({
      rule: 'button-name',
      identityBasis: 'count',
      count: 1,
    });
  });

  it('writes stable sorted JSON with a trailing newline and identical bytes on repeat', async () => {
    const config = testConfig();
    const deps = makeFakeDeps({
      ...withPolicyFiles({}),
      scans: {
        clusters: scanWith([
          draft({
            screenId: 'clusters',
            layer: 'pf',
            rule: 'pf-icon-button-name',
            evidence: {},
            elementName: null,
            role: null,
          }),
          draft({
            screenId: 'clusters',
            layer: 'axe',
            rule: 'color-contrast',
            evidence: { name: { value: 'Alert', source: 'ax-tree', fromTree: true } },
          }),
        ]),
      },
    });
    const firstWriter = new MemoryBaselineFs();
    const secondWriter = new MemoryBaselineFs();

    const first = await runBaseline(deps, config, firstWriter);
    const second = await runBaseline(deps, config, secondWriter);
    const firstBytes = firstWriter.read('.usabl-evidence.json');
    const secondBytes = secondWriter.read('.usabl-evidence.json');

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(firstBytes).not.toBeNull();
    expect(firstBytes).toBe(secondBytes);
    expect(firstBytes?.endsWith('\n')).toBe(true);
  });

  it('refuses with exit 2 when other guarded files are dirty', async () => {
    const config = testConfig();
    const deps = makeFakeDeps({
      ...withPolicyFiles(
        {
          'usabl.config.json': '{"appBaseUrl":"http://evil.test"}',
        },
        {
          'usabl.config.json': '{}',
          'fixtures/app/src/ClustersPage.tsx': 'export {};\n',
        },
      ),
      scans: {
        clusters: scanWith([draft()]),
      },
    });
    const writer = new MemoryBaselineFs();

    const result = await runBaseline(deps, config, writer);

    expect(result.exitCode).toBe(2);
    expect(result.wrote).toBe(false);
    expect(writer.writes).toHaveLength(0);
    expect(result.message).toContain('guarded path');
  });

  it('allows dirty .usabl-evidence.json alone and rewrites the floor', async () => {
    const config = testConfig();
    const deps = makeFakeDeps({
      ...withPolicyFiles(
        {
          '.usabl-evidence.json': '{"version":1,"entries":[{"screenId":"x","layer":"axe","rule":"y","elementKey":null,"identityBasis":"count","count":9}]}',
        },
        {
          '.usabl-evidence.json': '{"version":1,"entries":[]}',
          'usabl.config.json': '{}',
          'fixtures/app/src/ClustersPage.tsx': 'export {};\n',
        },
      ),
      scans: {
        clusters: scanWith([draft()]),
      },
    });
    const writer = new MemoryBaselineFs();

    const result = await runBaseline(deps, config, writer);

    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(true);
    expect(writer.writes).toHaveLength(1);
  });

  it('refuses with exit 4 and does not write when run crashes', async () => {
    const config = testConfig();
    const deps = makeFakeDeps({
      ...withPolicyFiles({}),
      scans: {
        clusters: scanWith([draft()]),
      },
    });
    deps.checkRunner.scan = async () => {
      throw new Error('browser disconnected');
    };
    const writer = new MemoryBaselineFs();

    const result = await runBaseline(deps, config, writer);

    expect(result.exitCode).toBe(4);
    expect(result.wrote).toBe(false);
    expect(writer.writes).toHaveLength(0);
    expect(result.message).toContain('crashed');
  });

  it('refuses with exit 2 when no UI files match the configured globs', async () => {
    const config: UsablConfig = testConfig({ uiFileGlobs: ['src/**/*.tsx'] });
    const deps = makeFakeDeps({
      ...withPolicyFiles({ README: '# docs\n' }),
      scans: {
        clusters: scanWith([draft()]),
      },
    });
    const writer = new MemoryBaselineFs();

    const result = await runBaseline(deps, config, writer);

    expect(result.exitCode).toBe(2);
    expect(result.wrote).toBe(false);
    expect(writer.writes).toHaveLength(0);
    expect(result.message).toContain('no UI files matched');
  });
});
