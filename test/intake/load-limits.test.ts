import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FsGlob, GitReader } from '../../src/contracts/index.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { loadRequirements } from '../../src/intake/load.js';
import { normalize } from '../../src/intake/normalize.js';
import { overlayRequirementsFs } from '../../src/intake/overlay-fs.js';
import { testConfig } from '../helpers.js';

// A requirement file has a byte limit, checked before the file is parsed. The real reader checks
// the size before it reads, so a huge file is never read whole. Every other reader is checked on
// the text it returns, so no path parses a file past the limit.

const LIMIT_BYTES = 128 * 1024;
const LIMIT_REASON = 'a requirement file can be at most 128 KiB; split it into smaller files';
const PATH = 'requirements/big.yaml';
const config = testConfig({ requirements: 'requirements/' });

const VALID = [
  'version: 1',
  'requirements:',
  '  - id: r1',
  '    kind: content',
  '    surface: home',
  '    description: d',
  '    approved: true',
  '    assertion: { type: content, selector: h1 }',
  '',
].join('\n');

// A valid file padded with a YAML comment to exactly the given number of bytes. The comment uses a
// two-byte character, so the limit is shown to count bytes, not characters.
function paddedTo(bytes: number): string {
  const room = bytes - Buffer.byteLength(VALID) - 2;
  const pad = 'é'.repeat(Math.floor(room / 2)) + (room % 2 === 1 ? 'x' : '');
  const text = `${VALID}# ${pad}`;
  expect(Buffer.byteLength(text)).toBe(bytes);
  return text;
}

function oneFile(read: Partial<FsGlob>): FsGlob {
  return { readFile: async () => null, glob: async () => [PATH], ...read };
}

const refused = { ok: false, verdict: 'approval_required', path: PATH, reason: `requirements path ${PATH}: ${LIMIT_REASON}` };

let dir: string | null = null;
afterEach(async () => {
  if (dir !== null) {
    await rm(dir, { recursive: true, force: true });
    dir = null;
  }
});

async function onDisk(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'usabl-load-limits-'));
  await mkdir(join(dir, 'requirements'));
  return dir;
}

describe('the byte limit of a requirement file', () => {
  it('loads a file of exactly 128 KiB and refuses one byte more', async () => {
    expect((await loadRequirements(oneFile({ readFile: async () => paddedTo(LIMIT_BYTES) }), config)).ok).toBe(true);
    expect(await loadRequirements(oneFile({ readFile: async () => paddedTo(LIMIT_BYTES + 1) }), config)).toEqual(refused);
  });

  it('refuses a file past the limit from any caller of normalize, such as the Figma import', () => {
    expect(normalize(paddedTo(LIMIT_BYTES + 1))).toEqual({ ok: false, verdict: 'approval_required', reason: LIMIT_REASON });
    expect(normalize(paddedTo(LIMIT_BYTES)).ok).toBe(true);
  });

  it('refuses a huge file on disk from its size, fast, without reading it', async () => {
    const root = await onDisk();
    // A sparse file: 512 MiB long, with no data on disk. Reading it would build a 512 MiB string.
    await writeFile(join(root, PATH), '');
    await truncate(join(root, PATH), 512 * 1024 * 1024);
    const started = performance.now();
    const result = await loadRequirements(makeFsGlob({ cwd: root }), config);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result).toEqual(refused);
  });

  it('loads a file on disk at exactly the limit and refuses one byte more', async () => {
    const root = await onDisk();
    await writeFile(join(root, PATH), paddedTo(LIMIT_BYTES));
    expect((await loadRequirements(makeFsGlob({ cwd: root }), config)).ok).toBe(true);
    await writeFile(join(root, PATH), paddedTo(LIMIT_BYTES + 1));
    expect(await loadRequirements(makeFsGlob({ cwd: root }), config)).toEqual(refused);
  });

  it('reads a file through the bounded read when the reader has one, never the whole file', async () => {
    const readFile = vi.fn(async () => {
      throw new Error('the whole file was read');
    });
    const readTextUpTo = vi.fn(async () => ({ kind: 'too-large' as const }));
    expect(await loadRequirements(oneFile({ readFile, readTextUpTo }), config)).toEqual(refused);
    expect(readTextUpTo).toHaveBeenCalledWith(PATH, LIMIT_BYTES);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('refuses a file past the limit at the trusted ref', async () => {
    const git: Pick<GitReader, 'lsFiles' | 'show'> = {
      lsFiles: async () => [PATH],
      show: async () => paddedTo(LIMIT_BYTES + 1),
    };
    const fs = overlayRequirementsFs(oneFile({}), git, config, 'origin/main');
    expect(await loadRequirements(fs, config)).toEqual(refused);
  });
});

describe('the bounded read of the real file reader', () => {
  it('gives the text of a file within the limit and says when a file is larger, without reading it', async () => {
    const root = await onDisk();
    await writeFile(join(root, 'requirements/a.yaml'), 'abc');
    await writeFile(join(root, 'requirements/b.yaml'), '');
    await truncate(join(root, 'requirements/b.yaml'), 512 * 1024 * 1024);
    const fs = makeFsGlob({ cwd: root });
    expect(await fs.readTextUpTo?.('requirements/a.yaml', 3)).toEqual({ kind: 'text', text: 'abc' });
    expect(await fs.readTextUpTo?.('requirements/a.yaml', 2)).toEqual({ kind: 'too-large' });
    expect(await fs.readTextUpTo?.('requirements/b.yaml', LIMIT_BYTES)).toEqual({ kind: 'too-large' });
    expect(await fs.readTextUpTo?.('requirements/none.yaml', LIMIT_BYTES)).toBeNull();
  });
});
