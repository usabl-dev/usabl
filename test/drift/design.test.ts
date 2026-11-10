/**
 * `usabl drift design`: approved requirements whose design file changed after they were recorded.
 * A fetch that fails, for any reason, is never read as "no drift", and the token is never printed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { computeDesignDrift, formatDesignDriftReport, runDesignDrift } from '../../src/drift/design.js';
import { parseCliArgs } from '../../src/surfaces/cli.js';
import { testConfig } from '../helpers.js';
import { MOCK_TOKEN, startMockFigma, type MockFigma } from '../import/figma/mock-server.js';

const nodes = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe('computeDesignDrift', () => {
  it('flags requirements whose design file has a newer version', () => {
    const drift = computeDesignDrift(
      [
        { requirementId: 'figma-users-name-1', file: 'MOCKKEY', node: '2:7', version: '4000' },
        { requirementId: 'figma-users-heading-1', file: 'MOCKKEY', node: '2:1', version: '4000' },
      ],
      { MOCKKEY: { version: '4242', nodes: nodes('2:1', '2:7') } },
    );
    expect(drift.hasDrift).toBe(true);
    expect(drift.unchecked).toEqual([]);
    expect(drift.changed).toEqual([
      {
        file: 'MOCKKEY',
        recorded: '4000',
        current: '4242',
        requirements: [
          { id: 'figma-users-heading-1', node: '2:1', nodeGone: false },
          { id: 'figma-users-name-1', node: '2:7', nodeGone: false },
        ],
      },
    ]);
    expect(formatDesignDriftReport(drift)).toBe(
      'The design file MOCKKEY changed after these requirements were approved (version 4000 to 4242):\n' +
        '  figma-users-heading-1\n' +
        '  figma-users-name-1\n' +
        'Review the design change, then update or import these requirements again.\n',
    );
  });

  it('says when the design node a requirement came from is gone', () => {
    const drift = computeDesignDrift(
      [{ requirementId: 'figma-users-name-1', file: 'K', node: '2:7', version: '1' }],
      { K: { version: '2', nodes: nodes('2:1') } },
    );
    expect(formatDesignDriftReport(drift)).toContain('  figma-users-name-1 (its design node 2:7 is no longer in the file)\n');
  });

  it('reports no drift when versions match', () => {
    const drift = computeDesignDrift([{ requirementId: 'r', file: 'K', node: '1:1', version: '1' }], {
      K: { version: '1', nodes: nodes('1:1') },
    });
    expect(drift.hasDrift).toBe(false);
    expect(formatDesignDriftReport(drift)).toBe(
      'No design drift. Every approved requirement matches the current version of its design file.\n',
    );
  });

  it('never reads a file it has no current version for as no drift', () => {
    const drift = computeDesignDrift([{ requirementId: 'r', file: 'K', node: '1:1', version: '1' }], {});
    expect(drift.hasDrift).toBe(false);
    expect(drift.unchecked).toEqual(['r']);
    expect(formatDesignDriftReport(drift)).not.toContain('No design drift');
    expect(formatDesignDriftReport(drift)).toContain('Design drift was not checked for: r');
  });

  it('reports each recorded version of one file as its own group, in a fixed order', () => {
    const drift = computeDesignDrift(
      [
        { requirementId: 'a', file: 'K', node: '1:1', version: '10' },
        { requirementId: 'b', file: 'K', node: '1:1', version: '9' },
        { requirementId: 'c', file: 'K', node: '1:1', version: '11' },
        { requirementId: 'd', file: 'A', node: '1:1', version: '1' },
      ],
      { K: { version: '11', nodes: nodes('1:1') }, A: { version: '2', nodes: nodes('1:1') } },
    );
    expect(drift.changed.map((group) => [group.file, group.recorded, group.requirements.map((r) => r.id)])).toEqual([
      ['A', '1', ['d']],
      ['K', '10', ['a']],
      ['K', '9', ['b']],
    ]);
  });
});

describe('runDesignDrift', () => {
  let mock: MockFigma;
  beforeAll(async () => {
    mock = await startMockFigma();
  });
  afterAll(async () => {
    await mock.close();
  });

  const yaml = `version: 1
requirements:
  - id: figma-users-heading-1
    kind: heading
    surface: users
    description: The heading "Users" is level 1, as in the design.
    assertion: { type: heading, name: Users, level: 1 }
    approved: true
    source: { tool: figma, file: MOCKKEY, node: "2:1", version: "4000" }
`;
  const draft = `  - id: figma-users-name-1
    kind: name
    surface: users
    description: A button is named "Refresh", as in the design.
    assertion: { type: name, target: { role: button, name: Refresh } }
    approved: false
    source: { tool: figma, file: MOCKKEY, node: "2:7", version: "4000" }
`;
  const config = testConfig({ requirements: 'requirements' });
  const fsWith = (text: string) => makeFakeDeps({ files: { 'requirements/figma.yaml': text } }).fs;
  const env = (extra: Record<string, string> = {}) => ({ FIGMA_TOKEN: MOCK_TOKEN, FIGMA_API_BASE: mock.base, ...extra });

  it('exits 1 with a report when the design is newer', async () => {
    const outcome = await runDesignDrift(fsWith(yaml), config, env());
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('(version 4000 to 4242)');
    expect(outcome.stdout).toContain('  figma-users-heading-1\n');
  });

  it('exits 0 when the recorded version is current', async () => {
    const outcome = await runDesignDrift(fsWith(yaml.replace('"4000"', '"4242"')), config, env());
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('No design drift.');
  });

  it('names a requirement whose design node was deleted', async () => {
    const outcome = await runDesignDrift(fsWith(yaml.replace('"2:1"', '"9:9"')), config, env());
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('figma-users-heading-1 (its design node 9:9 is no longer in the file)');
  });

  it('leaves out an unapproved draft, even in the same file', async () => {
    const outcome = await runDesignDrift(fsWith(yaml + draft), config, env());
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).not.toContain('figma-users-name-1');
    const onlyDraft = await runDesignDrift(fsWith(yaml.replace('approved: true', 'approved: false')), config, env());
    expect(onlyDraft).toEqual({ exitCode: 0, stdout: 'No approved requirement records a design source.\n' });
  });

  it('makes no network call when no approved requirement has a design source', async () => {
    const before = mock.seen.length;
    const outcome = await runDesignDrift(fsWith(yaml.replace(/\n {4}source:.*\n/u, '\n')), config, env());
    expect(outcome.exitCode).toBe(0);
    expect(mock.seen.length).toBe(before);
  });

  it('fetches each design file once, with one GET to the base it was given', async () => {
    const second = yaml.replace('figma-users-heading-1', 'figma-users-heading-2').replace('version: 1\nrequirements:\n', '');
    const before = mock.seen.length;
    await runDesignDrift(fsWith(yaml + second), config, env());
    expect(mock.seen.slice(before)).toEqual([{ method: 'GET', url: '/v1/files/MOCKKEY', token: MOCK_TOKEN }]);
  });

  it('exits 2 without the token', async () => {
    const outcome = await runDesignDrift(fsWith(yaml), config, { FIGMA_API_BASE: mock.base });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('Set FIGMA_TOKEN');
  });

  it.each([
    ['a refused token', { FIGMA_TOKEN: 'drift-secret-value-1' }, 'MOCKKEY', 'Figma refused the token'],
    ['an unknown file', { FIGMA_TOKEN: 'drift-secret-value-1' }, 'NOPE', 'Figma'],
    ['a server error that echoes the request', {}, 'BUSY', 'Figma answered 500'],
    ['a body it cannot read', {}, 'BROKEN', 'cannot read'],
  ])('exits 2 on %s, never says no drift, and never prints the token', async (_, extra, key, message) => {
    const text = yaml.replace('file: MOCKKEY', `file: ${key}`);
    const outcome = await runDesignDrift(fsWith(text), config, env(extra));
    expect(outcome.exitCode).toBe(2);
    const printed = `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`;
    expect(printed).toContain(message);
    expect(printed).toContain('Design drift was not checked.');
    expect(printed).not.toContain('No design drift');
    expect(printed).not.toContain('drift-secret-value-1');
    expect(printed).not.toContain(MOCK_TOKEN);
  });

  it('exits 2 when the network fails, and never prints the token', async () => {
    const failing = (() => Promise.reject(new Error(`connect failed with ${MOCK_TOKEN}`))) as typeof fetch;
    const outcome = await runDesignDrift(fsWith(yaml), config, env(), failing);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('Could not reach the Figma API');
    expect(outcome.stderr).not.toContain(MOCK_TOKEN);
  });

  it('exits 2 on an API base that would send the token in the clear', async () => {
    const outcome = await runDesignDrift(fsWith(yaml), config, env({ FIGMA_API_BASE: 'http://figma.example.test' }));
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('FIGMA_API_BASE must use https');
  });

  it('exits 2 with the reason when the requirements do not load', async () => {
    const outcome = await runDesignDrift(fsWith('version: 1\nrequirements: []\n'), config, env());
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('requirements must contain at least one entry');
  });
});

describe('drift design through the CLI', () => {
  it('parses drift design', () => {
    const parsed = parseCliArgs(['drift', 'design']);
    expect(parsed.command).toBe('drift');
    expect(parsed.driftSubcommand).toBe('design');
  });

  it('names both subcommands when none is given', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      expect(await main(['drift'])).toBe(2);
      expect(stderr.join('')).toContain('drift supports the routes and design subcommands');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
