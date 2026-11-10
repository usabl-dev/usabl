import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runImportCommand, type ImportOutcome } from '../../../src/import/figma/cli.js';
import type { FigmaNode } from '../../../src/import/figma/types.js';
import { normalize } from '../../../src/intake/normalize.js';
import { UNTRUSTED_FRAME_END, UNTRUSTED_FRAME_START } from '../../../src/surfaces/scrub.js';
import { MOCK_TOKEN, startMockFigma, type MockFigma } from './mock-server.js';
import { usersScreen } from './users-screen.fixture.js';

let mock: MockFigma;
beforeAll(async () => {
  mock = await startMockFigma();
});
afterAll(async () => {
  await mock.close();
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { FIGMA_TOKEN: MOCK_TOKEN, FIGMA_API_BASE: mock.base, ...extra };
}

function outPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'usabl-import-')), name);
}

function printed(outcome: ImportOutcome): string {
  return `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`;
}

describe('usabl import figma', () => {
  it('writes a draft requirements file and says what to do next', async () => {
    const out = outPath('figma-users.yaml');
    const outcome = await runImportCommand(['figma', 'MOCKKEY', '--frame', 'Users=users', '--out', out, '--min-target', '24'], env());
    expect(outcome.exitCode).toBe(0);
    const lines = outcome.stdout?.split('\n') ?? [];
    expect(lines[0]).toBe(`Wrote 5 draft requirements to ${out}.`);
    expect(outcome.stdout).toContain('1 Figma note was not turned into a check:');
    expect(outcome.stdout).toContain('Review each requirement, set approved: true, and commit. Nothing blocks until then.');
    const yaml = readFileSync(out, 'utf8');
    expect(yaml.startsWith('# Drafted by usabl import figma from MOCKKEY version 4242.')).toBe(true);
    const loaded = normalize(yaml);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.bundle.requirements).toHaveLength(5);
      expect(loaded.bundle.requirements.every((r) => r.approved === false)).toBe(true);
    }
    // The guidance comment tells a person to set approved: true. No requirement line says it.
    expect(yaml).not.toMatch(/^[ -]*approved: true/mu);
    expect(yaml.match(/^ {4}approved: false$/gmu)).toHaveLength(5);
    expect(yaml).not.toContain(MOCK_TOKEN);
  });

  it('frames the design notes it prints as untrusted text', async () => {
    const outcome = await runImportCommand(['figma', 'MOCKKEY', '--frame', 'Users=users', '--out', outPath('n.yaml')], env());
    const stdout = outcome.stdout ?? '';
    const start = stdout.indexOf(UNTRUSTED_FRAME_START);
    const end = stdout.indexOf(UNTRUSTED_FRAME_END);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(stdout.slice(start, end)).toContain("Announce 'Refreshing'");
  });

  it('refuses to overwrite an existing file', async () => {
    const out = outPath('x.yaml');
    writeFileSync(out, 'keep');
    const outcome = await runImportCommand(['figma', 'MOCKKEY', '--frame', 'Users=users', '--out', out], env());
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('already exists');
    expect(readFileSync(out, 'utf8')).toBe('keep');
  });

  it('explains a missing token and never prints one', async () => {
    const out = outPath('never.yaml');
    const missing = await runImportCommand(['figma', 'MOCKKEY', '--frame', 'Users=users', '--out', out], { FIGMA_API_BASE: mock.base });
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain('Set FIGMA_TOKEN');
    const refused = await runImportCommand(['figma', 'MOCKKEY', '--frame', 'Users=users', '--out', out], env({ FIGMA_TOKEN: 'wrong-secret-value' }));
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain('Figma refused the token');
    expect(printed(refused)).not.toContain('wrong-secret-value');
    expect(existsSync(out)).toBe(false);
  });

  it('never prints the token, whatever goes wrong', async () => {
    const secret = 'figd_never-print-this-0123456789';
    const runs = [
      ['figma', 'NOPE', '--frame', 'Users=users', '--out', outPath('a.yaml')],
      ['figma', 'BUSY', '--frame', 'Users=users', '--out', outPath('b.yaml')],
      ['figma', 'MOCKKEY', '--frame', 'Nope=users', '--out', outPath('c.yaml')],
      ['figma', 'MOCKKEY', '--frame', 'Users=users', '--out', join(outPath('d'), 'missing-dir', 'e.yaml')],
      ['figma', secret, '--frame', 'Users=users', '--out', outPath('f.yaml')],
    ];
    for (const args of runs) {
      const outcome = await runImportCommand(args, env({ FIGMA_TOKEN: secret }));
      expect(outcome.exitCode).toBe(2);
      expect(printed(outcome)).not.toContain(secret);
    }
  });

  it('calls only the API base it was given, with one GET', async () => {
    const before = mock.seen.length;
    await runImportCommand(['figma', 'MOCKKEY', '--frame', 'Users=users', '--out', outPath('g.yaml')], env());
    expect(mock.seen.slice(before)).toEqual([{ method: 'GET', url: '/v1/files/MOCKKEY', token: MOCK_TOKEN }]);
  });

  it('refuses an API base that would send the token in the clear', async () => {
    const outcome = await runImportCommand(
      ['figma', 'MOCKKEY', '--frame', 'Users=users', '--out', outPath('h.yaml')],
      env({ FIGMA_API_BASE: 'http://figma.example.test' }),
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('FIGMA_API_BASE must use https');
  });

  it('refuses an unknown option, because a typo could drop a frame', async () => {
    const out = outPath('typo.yaml');
    const outcome = await runImportCommand(['figma', 'MOCKKEY', '--frames', 'Users=users', '--out', out], env());
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('usabl import: unknown option --frames');
    expect(existsSync(out)).toBe(false);
  });

  it.each([
    [['figma'], 'give the Figma file key'],
    [['other', 'K', '--frame', 'A=a', '--out', 'x'], 'the only source is figma'],
    [['figma', '../K', '--frame', 'A=a', '--out', 'x'], 'file key must be a Figma file key'],
    [['figma', 'K', '--out', 'x'], 'give at least one --frame'],
    [['figma', 'K', '--frame', 'A=a'], 'give --out'],
    [['figma', 'K', '--frame', 'A', '--out', 'x'], '--frame takes <Frame name>=<surface id>'],
    [['figma', 'K', '--frame', 'A=my users', '--out', 'x'], 'surface id'],
    [['figma', 'K', '--frame', 'A=a', '--out', 'x', '--min-target', '0'], '--min-target takes a size from 1 to 200'],
    [['figma', 'K', '--frame', 'A=a', '--out', 'x', '--owner', 'line\nbreak'], '--owner'],
    [['figma', 'K', '--frame', 'A=a', '--out'], '--out needs a value'],
  ])('refuses %j before it calls Figma', async (args, message) => {
    const before = mock.seen.length;
    const outcome = await runImportCommand(args, env());
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain(message);
    expect(mock.seen.length).toBe(before);
  });

  it('reports a frame the file does not have', async () => {
    const out = outPath('missing.yaml');
    const outcome = await runImportCommand(['figma', 'MOCKKEY', '--frame', 'Settings=settings', '--out', out], env());
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('The Figma file has no frame named "Settings".');
    expect(existsSync(out)).toBe(false);
  });

  it('reports an unknown file key', async () => {
    const outcome = await runImportCommand(['figma', 'NOPE', '--frame', 'Users=users', '--out', outPath('n.yaml')], env());
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('Figma has no file with key NOPE');
  });
});

describe('usabl import figma frames', () => {
  // The mock Users file plus a Settings frame that holds no kit notes.
  const withSettings = structuredClone(usersScreen);
  const canvas = withSettings.document.children?.[0];
  const users = canvas?.children?.[0];
  if (canvas === undefined || users === undefined) throw new Error('fixture has no Users frame');
  const settings: FigmaNode = { ...users, id: '5:0', name: 'Settings', children: [] };
  canvas.children?.push(settings);

  let two: MockFigma;
  beforeAll(async () => {
    two = await startMockFigma(withSettings);
  });
  afterAll(async () => {
    await two.close();
  });

  it('names a frame that gives no requirements, and still writes the others', async () => {
    const out = outPath('two.yaml');
    const outcome = await runImportCommand(['figma', 'MOCKKEY', '--frame', 'Users=users', '--frame', 'Settings=settings', '--out', out], {
      FIGMA_TOKEN: MOCK_TOKEN,
      FIGMA_API_BASE: two.base,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('Warning: the frame "Settings" gave no requirements.\n');
    expect(existsSync(out)).toBe(true);
  });

  it('names the frames and prints the notes when no frame gives a requirement', async () => {
    const out = outPath('none.yaml');
    const outcome = await runImportCommand(['figma', 'MOCKKEY', '--frame', 'Settings=settings', '--out', out], {
      FIGMA_TOKEN: MOCK_TOKEN,
      FIGMA_API_BASE: two.base,
    });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('usabl import: the frame "Settings" gave no requirements, so there is nothing to write.');
    expect(existsSync(out)).toBe(false);
  });

  it('refuses the same Figma frame in two --frame options', async () => {
    const out = outPath('twice.yaml');
    const outcome = await runImportCommand(['figma', 'MOCKKEY', '--frame', 'Users=users', '--frame', ' Users =admin', '--out', out], env());
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('usabl import: the frame "Users" is given in two --frame options. Give each frame once.');
    expect(existsSync(out)).toBe(false);
  });
});
