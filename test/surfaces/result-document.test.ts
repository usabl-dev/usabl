/**
 * A Result read from standard input is a document someone else wrote. `usabl comment` and
 * `usabl enforce` both read one, and both trust it only after it matches the Result contract
 * field by field. These tests take a complete, valid Result, break one field at a time, and expect
 * a refusal that names the field by its path and never repeats the value it found there.
 */
import { readFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { InputRefusedError } from '../../src/intake/input-refusal.js';
import { parseResultJson } from '../../src/surfaces/policy-enforce.js';

// Text that would render as a live mention if it reached the comment outside a code span. Every
// bad value below carries it, and no refusal may repeat it.
const LEAK = '@leak-me';

function validResult(): Record<string, unknown> {
  return {
    schemaVersion: 'usabl.result.v1',
    verdict: 'regression',
    summary: 'regression: 1 blocking finding(s)',
    screens: [
      {
        screenId: 'clusters',
        url: 'http://127.0.0.1:5173/clusters',
        stops: [
          {
            index: 0,
            elementPath: 'button',
            announcement: [{ kind: 'name', text: 'Save', fromTree: true, source: 'ax-tree' }],
          },
        ],
        drafts: [],
        gaps: [{ ref: 'clusters', state: 'not-covered', reason: 'dialog did not open' }],
        applicability: [{ screenId: 'clusters', layer: 'axe', rule: 'button-name', outcome: 'passed', elementCount: 2 }],
        reachedSelectorPresent: true,
        reachedWhenSelector: '#clusters-table',
        reachedResponseSeen: null,
        reachedWhenResponse: null,
      },
    ],
    coverage: {
      changedFiles: ['src/Clusters.tsx'],
      affected: [
        {
          screenId: 'clusters',
          url: 'http://127.0.0.1:5173/clusters',
          provenance: 'route-graph',
          importChain: ['src/App.tsx', 'src/Clusters.tsx'],
          profile: 'app',
        },
      ],
      unresolvedFiles: [],
      gaps: [],
      nothingToCheck: false,
    },
    findings: [
      {
        rule: 'color-contrast',
        layer: 'axe',
        severity: 'serious',
        evidenceClass: 'deterministic',
        screenId: 'clusters',
        elementPath: 'button',
        elementName: 'Save',
        role: 'button',
        whatUserExperiences: 'Low contrast',
        why: 'ratio 2:1',
        fix: 'Raise to 4.5:1',
        evidence: {
          name: { value: 'Save', source: 'ax-tree', fromTree: true },
          role: { value: null, source: 'attribute', fromTree: false },
          state: { expanded: { value: false, source: 'ax-tree', fromTree: true } },
          extra: { ratio: 2 },
        },
        confidence: 'fail',
        elementKey: 'clusters|color-contrast|name:save',
        identityBasis: 'name',
        status: 'new',
        appSource: { tier: 'renderer', file: 'src/Clusters.tsx', line: 12, candidates: [] },
      },
      {
        rule: 'image-alt',
        layer: 'docs',
        severity: 'critical',
        evidenceClass: 'preview',
        screenId: 'guide',
        elementPath: 'img',
        elementName: null,
        role: null,
        whatUserExperiences: 'No text',
        why: 'missing alt',
        fix: 'Add alt',
        evidence: {},
        confidence: 'unverified',
        elementKey: null,
        identityBasis: 'count',
        status: 'carried',
        docsSource: {
          tier: 'content',
          file: 'guide.adoc',
          candidates: ['guide.adoc'],
          construct: 'image::x.png[]',
          line: null,
          fix: 'image::x.png[Diagram]',
        },
      },
    ],
    receipt: {
      schemaVersion: 1,
      sourceTree: 'tree',
      baseRevision: null,
      policyHash: 'hash',
      runnerVersion: '0.2.2',
      scannerVersions: { axeCore: '4', playwright: '1', chromium: '1' },
      surfaces: ['cli'],
      coverage: { checked: ['clusters'], notCovered: [] },
      applicability: [{ screenId: 'clusters', applied: 1, abstained: 0 }],
      verdict: 'verified',
      findingsSummary: { new: 0, carried: 1, fixed: 0, unverified: 0 },
      activeWaivers: 0,
      mintedAt: '2026-01-01T00:00:00.000Z',
    },
    dirtyGuardedPaths: ['usabl.config.json'],
    exitCode: 1,
    accessibilityVerdict: 'regression',
    accessibilityExitCode: 1,
    paidDownCount: 0,
    floorHeadroom: [{ screenId: 'clusters', rule: 'button-name', recorded: 3, observed: 1 }],
    floorUnconfirmed: [{ screenId: 'clusters', rules: ['button-name', 'image-alt'], barriers: 2 }],
  };
}

type Path = (string | number)[];

function withValue(path: Path, value: unknown): Record<string, unknown> {
  const doc = validResult();
  let cursor: Record<string | number, unknown> = doc;
  for (const key of path.slice(0, -1)) {
    cursor = cursor[key] as Record<string | number, unknown>;
  }
  cursor[path[path.length - 1]!] = value;
  return doc;
}

function without(path: Path): Record<string, unknown> {
  const doc = validResult();
  let cursor: Record<string | number, unknown> = doc;
  for (const key of path.slice(0, -1)) {
    cursor = cursor[key] as Record<string | number, unknown>;
  }
  delete cursor[path[path.length - 1]!];
  return doc;
}

function refusal(doc: unknown): InputRefusedError {
  try {
    parseResultJson(doc);
  } catch (err) {
    expect(err).toBeInstanceOf(InputRefusedError);
    return err as InputRefusedError;
  }
  throw new Error('expected the Result to be refused');
}

describe('parseResultJson validates the whole Result against the contract', () => {
  it('accepts a complete valid Result and returns the same content', () => {
    expect(parseResultJson(validResult())).toEqual(validResult());
  });

  it('accepts every golden Result the engine wrote', async () => {
    const dir = new URL('../../fixtures/golden/', import.meta.url);
    for (const name of await readdir(dir)) {
      const doc: unknown = JSON.parse(await readFile(new URL(name, dir), 'utf8'));
      expect(() => parseResultJson(doc), name).not.toThrow();
    }
  });

  // One case per kind of shape: a count that is text, a list that is not a list, an enum value
  // outside its set, a nested object missing a field, a nullable field holding the wrong type,
  // and an optional field present with the wrong type.
  const cases: { field: string; doc: () => Record<string, unknown> }[] = [
    { field: 'verdict', doc: () => withValue(['verdict'], LEAK) },
    { field: 'summary', doc: () => withValue(['summary'], { text: LEAK }) },
    { field: 'exitCode', doc: () => withValue(['exitCode'], LEAK) },
    { field: 'exitCode', doc: () => withValue(['exitCode'], 7) },
    { field: 'paidDownCount', doc: () => withValue(['paidDownCount'], 1.5) },
    { field: 'paidDownCount', doc: () => withValue(['paidDownCount'], LEAK) },
    { field: 'dirtyGuardedPaths', doc: () => withValue(['dirtyGuardedPaths'], { length: LEAK }) },
    { field: 'dirtyGuardedPaths[0]', doc: () => withValue(['dirtyGuardedPaths', 0], 5) },
    { field: 'screens', doc: () => withValue(['screens'], { length: LEAK }) },
    { field: 'screens[0].stops[0].index', doc: () => withValue(['screens', 0, 'stops', 0, 'index'], LEAK) },
    { field: 'screens[0].stops[0].announcement[0].kind', doc: () => withValue(['screens', 0, 'stops', 0, 'announcement', 0, 'kind'], LEAK) },
    { field: 'screens[0].gaps[0].state', doc: () => withValue(['screens', 0, 'gaps', 0, 'state'], LEAK) },
    { field: 'screens[0].applicability[0].outcome', doc: () => withValue(['screens', 0, 'applicability', 0, 'outcome'], LEAK) },
    { field: 'screens[0].applicability[0].elementCount', doc: () => withValue(['screens', 0, 'applicability', 0, 'elementCount'], -1) },
    { field: 'screens[0].reachedSelectorPresent', doc: () => withValue(['screens', 0, 'reachedSelectorPresent'], LEAK) },
    { field: 'screens[0].reachedWhenSelector', doc: () => withValue(['screens', 0, 'reachedWhenSelector'], 3) },
    { field: 'coverage', doc: () => withValue(['coverage'], LEAK) },
    { field: 'coverage.nothingToCheck', doc: () => without(['coverage', 'nothingToCheck']) },
    { field: 'coverage.affected[0].provenance', doc: () => withValue(['coverage', 'affected', 0, 'provenance'], LEAK) },
    { field: 'coverage.affected[0].importChain', doc: () => withValue(['coverage', 'affected', 0, 'importChain'], LEAK) },
    { field: 'coverage.affected[0].profile', doc: () => withValue(['coverage', 'affected', 0, 'profile'], LEAK) },
    { field: 'coverage.gaps', doc: () => withValue(['coverage', 'gaps'], { length: LEAK }) },
    { field: 'findings[0].severity', doc: () => withValue(['findings', 0, 'severity'], LEAK) },
    { field: 'findings[0].status', doc: () => withValue(['findings', 0, 'status'], LEAK) },
    { field: 'findings[0].evidenceClass', doc: () => withValue(['findings', 0, 'evidenceClass'], LEAK) },
    { field: 'findings[0].confidence', doc: () => withValue(['findings', 0, 'confidence'], LEAK) },
    { field: 'findings[0].identityBasis', doc: () => withValue(['findings', 0, 'identityBasis'], LEAK) },
    { field: 'findings[0].rule', doc: () => without(['findings', 0, 'rule']) },
    { field: 'findings[0].elementName', doc: () => withValue(['findings', 0, 'elementName'], 4) },
    { field: 'findings[0].elementKey', doc: () => withValue(['findings', 0, 'elementKey'], ['k']) },
    { field: 'findings[0].evidence', doc: () => withValue(['findings', 0, 'evidence'], LEAK) },
    { field: 'findings[0].evidence.name.source', doc: () => withValue(['findings', 0, 'evidence', 'name', 'source'], LEAK) },
    { field: 'findings[0].evidence.state entry 1', doc: () => withValue(['findings', 0, 'evidence', 'state', 'expanded'], LEAK) },
    { field: 'findings[0].evidence.extra', doc: () => withValue(['findings', 0, 'evidence', 'extra'], [LEAK]) },
    { field: 'findings[0].appSource.tier', doc: () => withValue(['findings', 0, 'appSource', 'tier'], LEAK) },
    { field: 'findings[0].appSource.line', doc: () => withValue(['findings', 0, 'appSource', 'line'], LEAK) },
    { field: 'findings[1].docsSource.candidates', doc: () => withValue(['findings', 1, 'docsSource', 'candidates'], LEAK) },
    { field: 'receipt', doc: () => withValue(['receipt'], LEAK) },
    { field: 'receipt.verdict', doc: () => withValue(['receipt', 'verdict'], 'regression') },
    { field: 'receipt.findingsSummary.new', doc: () => withValue(['receipt', 'findingsSummary', 'new'], LEAK) },
    { field: 'receipt.scannerVersions.axeCore', doc: () => without(['receipt', 'scannerVersions', 'axeCore']) },
    { field: 'receipt.applicability[0].applied', doc: () => withValue(['receipt', 'applicability', 0, 'applied'], LEAK) },
    { field: 'floorHeadroom[0].recorded', doc: () => withValue(['floorHeadroom', 0, 'recorded'], LEAK) },
    { field: 'floorHeadroom', doc: () => without(['floorHeadroom']) },
    { field: 'floorUnconfirmed', doc: () => without(['floorUnconfirmed']) },
    { field: 'floorUnconfirmed', doc: () => withValue(['floorUnconfirmed'], { length: LEAK }) },
    { field: 'floorUnconfirmed[0].screenId', doc: () => withValue(['floorUnconfirmed', 0, 'screenId'], 7) },
    { field: 'floorUnconfirmed[0].rules', doc: () => withValue(['floorUnconfirmed', 0, 'rules'], LEAK) },
    { field: 'floorUnconfirmed[0].rules[1]', doc: () => withValue(['floorUnconfirmed', 0, 'rules', 1], { rule: LEAK }) },
    { field: 'floorUnconfirmed[0].barriers', doc: () => withValue(['floorUnconfirmed', 0, 'barriers'], 1.5) },
    { field: 'floorUnconfirmed[0].barriers', doc: () => withValue(['floorUnconfirmed', 0, 'barriers'], LEAK) },
  ];

  for (const { field, doc } of cases) {
    it(`refuses a malformed ${field}, naming the field and never the value`, () => {
      const err = refusal(doc());
      expect(err.field).toBe(field);
      expect(err.message).toContain(field);
      expect(err.message).not.toContain(LEAK);
      expect(err.message).not.toContain('leak-me');
    });
  }

  it('never repeats a record key, which is page text, when it names a bad state entry', () => {
    const doc = validResult();
    const finding = (doc['findings'] as Record<string, unknown>[])[0]!;
    (finding['evidence'] as Record<string, unknown>)['state'] = { [LEAK]: { value: 1, source: LEAK, fromTree: true } };
    const err = refusal(doc);
    expect(err.field).toBe('findings[0].evidence.state entry 1.source');
    expect(err.message).not.toContain('leak-me');
  });

  it('keeps an own key named __proto__ as data and does not change the prototype', () => {
    const doc: unknown = JSON.parse(
      JSON.stringify(validResult()).replace('"extra":{"ratio":2}', '"extra":{"__proto__":{"polluted":true}}'),
    );
    const parsed = parseResultJson(doc);
    const extra = parsed.findings[0]!.evidence.extra!;
    expect(Object.getPrototypeOf(extra)).toBe(Object.prototype);
    expect(Object.hasOwn(extra, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('drops fields the contract does not name, so no projector reads them', () => {
    const doc = validResult();
    doc['injected'] = LEAK;
    expect(Object.hasOwn(parseResultJson(doc), 'injected')).toBe(false);
  });
});

describe('parseResultJson refuses a verdict that disagrees with its exit code', () => {
  const withFields = (fields: Record<string, unknown>): Record<string, unknown> => ({ ...validResult(), ...fields });

  // usabl enforce exits on the exit code and usabl comment shows the verdict. A document where the
  // two disagree would show one outcome and exit with another.
  const refused: Array<[string, string, Record<string, unknown>]> = [
    ['a regression that exits 0', 'exitCode', { verdict: 'regression', exitCode: 0 }],
    ['a verified run that exits 1', 'exitCode', { verdict: 'verified', exitCode: 1, accessibilityVerdict: 'verified', accessibilityExitCode: 0 }],
    ['an approval_required run that exits 0', 'exitCode', { verdict: 'approval_required', exitCode: 0 }],
    ['a not_covered run that exits 2', 'exitCode', { verdict: 'not_covered', exitCode: 2, accessibilityVerdict: 'not_covered', accessibilityExitCode: 3 }],
    ['a run with no verdict that exits 1', 'exitCode', { verdict: null, exitCode: 1 }],
    ['a run with no verdict that exits 3', 'exitCode', { verdict: null, exitCode: 3 }],
    ['a regression that exits 5', 'exitCode', { verdict: 'regression', exitCode: 5 }],
    ['a run with no verdict that exits 5', 'exitCode', { verdict: null, exitCode: 5 }],
    ['an accessibility regression that exits 0', 'accessibilityExitCode', { accessibilityVerdict: 'regression', accessibilityExitCode: 0 }],
    ['an accessibility verified that exits 3', 'accessibilityExitCode', { verdict: 'approval_required', exitCode: 2, accessibilityVerdict: 'verified', accessibilityExitCode: 3 }],
    ['an accessibility not_covered that exits 4', 'accessibilityExitCode', { verdict: null, exitCode: 4, accessibilityVerdict: 'not_covered', accessibilityExitCode: 4 }],
    ['no accessibility verdict that exits 1', 'accessibilityExitCode', { verdict: 'approval_required', exitCode: 2, accessibilityVerdict: null, accessibilityExitCode: 1 }],
  ];
  for (const [name, field, fields] of refused) {
    it(`refuses ${name}, naming ${field}`, () => {
      const err = refusal(withFields(fields));
      expect(err.field).toBe(field);
      expect(err.message).toContain(field);
    });
  }

  // Every pair the engine writes: each verdict with its own code, an idle run (no verdict, 0), a
  // run that crashed and failed open (no verdict, 4), and an approval hold over each scan outcome.
  const accepted: Array<[string, Record<string, unknown>]> = [
    ['a verified run', { verdict: 'verified', exitCode: 0, accessibilityVerdict: 'verified', accessibilityExitCode: 0 }],
    ['a regression', { verdict: 'regression', exitCode: 1, accessibilityVerdict: 'regression', accessibilityExitCode: 1 }],
    ['a not_covered run', { verdict: 'not_covered', exitCode: 3, accessibilityVerdict: 'not_covered', accessibilityExitCode: 3 }],
    ['an idle run', { verdict: null, exitCode: 0, accessibilityVerdict: null, accessibilityExitCode: 0 }],
    ['a run that crashed', { verdict: null, exitCode: 4, accessibilityVerdict: null, accessibilityExitCode: 4 }],
    ['an approval hold over an idle scan', { verdict: 'approval_required', exitCode: 2, accessibilityVerdict: null, accessibilityExitCode: 0 }],
    ['an approval hold over a regression', { verdict: 'approval_required', exitCode: 2, accessibilityVerdict: 'regression', accessibilityExitCode: 1 }],
  ];
  for (const [name, fields] of accepted) {
    it(`accepts ${name}`, () => {
      expect(() => parseResultJson(withFields(fields))).not.toThrow();
    });
  }

  it('usabl enforce accessibility exits 4 on a regression that claims exit 0', async () => {
    const restore = withStdin(JSON.stringify(withFields({ accessibilityVerdict: 'regression', accessibilityExitCode: 0 })));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['enforce', 'accessibility'])).toBe(4);
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('accessibilityExitCode');
    } finally {
      restore();
      vi.restoreAllMocks();
    }
  });
});

function withStdin(text: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: Readable.from([text]), configurable: true });
  return () => {
    if (original !== undefined) {
      Object.defineProperty(process, 'stdin', original);
    }
  };
}

describe('usabl comment and usabl enforce refuse a malformed Result', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runWith(argv: string[], text: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const restore = withStdin(text);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(argv);
      return {
        code,
        stdout: stdout.mock.calls.map((call) => String(call[0])).join(''),
        stderr: stderr.mock.calls.map((call) => String(call[0])).join(''),
      };
    } finally {
      restore();
    }
  }

  it('comment keeps the notice for floored barriers the run could not confirm', async () => {
    const out = await runWith(['comment'], JSON.stringify(validResult()));
    expect(out.stdout).toContain('2 recorded barriers on screen clusters (button-name, image-alt)');
  });

  it('comment exits 4 with a plain reason that names the field', async () => {
    const out = await runWith(['comment'], JSON.stringify(withValue(['findings', 0, 'severity'], LEAK)));
    expect(out.code).toBe(4);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('findings[0].severity');
    expect(out.stderr).not.toContain('leak-me');
  });

  it('comment exits 4 on text that is not JSON and does not repeat it', async () => {
    const out = await runWith(['comment'], `{"summary": "${LEAK}"`);
    expect(out.code).toBe(4);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/not valid JSON/);
    expect(out.stderr).not.toContain('leak-me');
  });

  it('comment still renders a valid Result and exits with its exit code', async () => {
    const out = await runWith(['comment', '--config', 'does-not-exist.json'], JSON.stringify(validResult()));
    expect(out.code).toBe(1);
    expect(out.stdout).toContain('<!-- usabl-report -->');
  });

  it('enforce accessibility exits 4 with the same reason', async () => {
    const out = await runWith(['enforce', 'accessibility'], JSON.stringify(withValue(['exitCode'], LEAK)));
    expect(out.code).toBe(4);
    expect(out.stderr).toContain('exitCode');
    expect(out.stderr).not.toContain('leak-me');
  });

  it('enforce exits 4 on text that is not JSON and does not repeat it', async () => {
    const out = await runWith(['enforce', 'accessibility'], `${LEAK}`);
    expect(out.code).toBe(4);
    expect(out.stderr).not.toContain('leak-me');
  });
});

// A control in a keyed table row has identity basis row. Its element key names the row by hashes.
const ROW_KEY = 'clusters|button-name|row:["0123456789abcdef","fedcba9876543210","button","td:nth-child(2)>button:nth-child(1)"]';

function withRowFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  const doc = validResult();
  const findings = doc['findings'] as Record<string, unknown>[];
  findings[0] = {
    ...findings[0],
    rule: 'button-name',
    elementKey: ROW_KEY,
    identityBasis: 'row',
    evidence: { extra: { rowScope: { table: '0123456789abcdef', row: 'fedcba9876543210', role: 'button', path: 'td:nth-child(2)>button:nth-child(1)' } } },
    ...over,
  };
  return doc;
}

describe('a Result with findings keyed by table row', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is accepted, with its row basis and key kept', () => {
    const parsed = parseResultJson(withRowFinding());
    expect(parsed.findings[0]?.identityBasis).toBe('row');
    expect(parsed.findings[0]?.elementKey).toBe(ROW_KEY);
  });

  it('is accepted by usabl comment and usabl enforce', async () => {
    const restoreComment = withStdin(JSON.stringify(withRowFinding()));
    const commentOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main(['comment', '--config', 'does-not-exist.json'])).toBe(1);
      expect(commentOut.mock.calls.map((call) => String(call[0])).join('')).toContain('<!-- usabl-report -->');
    } finally {
      restoreComment();
    }
    const restoreEnforce = withStdin(JSON.stringify(withRowFinding()));
    try {
      expect(await main(['enforce', 'accessibility'])).toBe(1);
    } finally {
      restoreEnforce();
    }
  });

  it('still refuses an identity basis outside the set, without repeating it', () => {
    const err = refusal(withRowFinding({ identityBasis: 'Row' }));
    expect(err.message).toContain('findings[0].identityBasis');
    expect(err.message).not.toContain('Row');
  });

  it('refuses a row finding with no element key', () => {
    const err = refusal(withRowFinding({ elementKey: null }));
    expect(err.message).toContain('findings[0].elementKey');
  });
});
