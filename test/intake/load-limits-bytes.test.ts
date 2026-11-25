import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitReader } from '../../src/contracts/index.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { runImportCommand } from '../../src/import/figma/cli.js';
import { loadRequirements } from '../../src/intake/load.js';
import { overlayRequirementsFs } from '../../src/intake/overlay-fs.js';
import { kit, rect, screen, text } from '../import/figma/build-file.js';
import { MOCK_TOKEN, startMockFigma } from '../import/figma/mock-server.js';
import { testConfig } from '../helpers.js';

// The byte limit counts the bytes of the file as stored, once. A byte that is not valid UTF-8, such
// as a Latin-1 letter, reads as a replacement character three bytes long, so counting the text
// after it is read would refuse a file well under the limit that loads on main.

const execFileAsync = promisify(execFile);
const LIMIT_BYTES = 128 * 1024;
const PATH = 'requirements/latin1.yaml';
const config = testConfig({ requirements: 'requirements/' });
const refused = {
  ok: false,
  verdict: 'approval_required',
  path: PATH,
  reason: `requirements path ${PATH}: a requirement file can be at most 128 KiB; split it into smaller files`,
};

const VALID = [
  'version: 1',
  'requirements:',
  '  - id: r1',
  '    kind: content',
  '    surface: home',
  '    description: d',
  '    approved: true',
  '    assertion: { type: content, selector: h1 }',
  '# ',
].join('\n');

// A valid file of exactly the given size, whose comment is Latin-1 bytes for the letter é.
function latin1(bytes: number): Buffer {
  const head = Buffer.from(VALID, 'utf8');
  const file = Buffer.concat([head, Buffer.alloc(bytes - head.length, 0xe9)]);
  expect(file.length).toBe(bytes);
  return file;
}

let root = '';
afterEach(async () => {
  if (root !== '') {
    await rm(root, { recursive: true, force: true });
    root = '';
  }
});

async function folder(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'usabl-load-bytes-'));
  await mkdir(join(root, 'requirements'));
  return root;
}

describe('the byte limit counts the file as stored', () => {
  it('loads a 100 KiB file with Latin-1 bytes, as main does', async () => {
    const dir = await folder();
    await writeFile(join(dir, PATH), latin1(100 * 1024));
    expect((await loadRequirements(makeFsGlob({ cwd: dir }), config)).ok).toBe(true);
  });

  it('loads a Latin-1 file of exactly 128 KiB on disk and refuses one byte more', async () => {
    const dir = await folder();
    await writeFile(join(dir, PATH), latin1(LIMIT_BYTES));
    expect((await loadRequirements(makeFsGlob({ cwd: dir }), config)).ok).toBe(true);
    await writeFile(join(dir, PATH), latin1(LIMIT_BYTES + 1));
    expect(await loadRequirements(makeFsGlob({ cwd: dir }), config)).toEqual(refused);
  });

  it(
    'counts a file at the trusted ref by the size git stores, the same as on disk',
    async () => {
      const dir = await folder();
      const git = async (args: string[]): Promise<void> => {
        await execFileAsync('git', args, { cwd: dir });
      };
      await git(['init', '--initial-branch=main']);
      await git(['config', 'user.name', 'Test User']);
      await git(['config', 'user.email', 'test@example.com']);
      await writeFile(join(dir, PATH), latin1(100 * 1024));
      await git(['add', '-A']);
      await git(['commit', '-m', 'within']);
      const read = () => loadRequirements(overlayRequirementsFs(makeFsGlob({ cwd: dir }), makeGitReader({ cwd: dir }), config, 'main'), config);
      expect((await read()).ok).toBe(true);
      await writeFile(join(dir, PATH), latin1(LIMIT_BYTES + 1));
      await git(['commit', '-am', 'over']);
      expect(await read()).toEqual(refused);
    },
    30_000,
  );

  it('refuses a file at the trusted ref from its stored size, without reading it', async () => {
    const show = vi.fn(async () => {
      throw new Error('the whole file was read');
    });
    const git: Pick<GitReader, 'lsFiles' | 'show' | 'blobSize'> = {
      lsFiles: async () => [PATH],
      show,
      blobSize: async () => 10 * 1024 * 1024,
    };
    const fs = overlayRequirementsFs({ readFile: async () => null, glob: async () => [PATH] }, git, config, 'main');
    expect(await loadRequirements(fs, config)).toEqual(refused);
    expect(show).not.toHaveBeenCalled();
  });
});

describe('a Figma import whose drafted file is over the byte limit', () => {
  it('says no file was written and why, and how to import the design', async () => {
    // 400 heading stamps in one frame draft about 400 requirements, more than 128 KiB of YAML.
    const nodes = Array.from({ length: 400 }, (_, index) => [
      text(`t${index}`, `Heading ${index}`, rect(0, index * 50, 200, 40)),
      kit(`h${index}`, 'heading', rect(0, index * 50, 20, 20), { Level: 'h2' }),
    ]).flat();
    const mock = await startMockFigma(screen(nodes));
    try {
      const dir = await folder();
      const out = join(dir, 'big.yaml');
      const outcome = await runImportCommand(['figma', 'MOCKKEY', '--frame', 'Screen=screen', '--out', out], {
        FIGMA_TOKEN: MOCK_TOKEN,
        FIGMA_API_BASE: mock.base,
      });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.stderr).toBe(
        'usabl import: the drafted requirements are larger than 128 KiB, the most one requirement file can hold, so no file was written. Import fewer frames at a time, each with its own --out.\n',
      );
      expect(existsSync(out)).toBe(false);
    } finally {
      await mock.close();
    }
  });
});
