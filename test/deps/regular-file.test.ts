/**
 * Every working-tree read refuses a path that is not a regular file, at once. A plain read of a
 * named pipe waits for a writer that may never come, holds a thread of Node's shared pool while it
 * waits, and keeps the process from exiting. A refused path is an error, never an empty file, and
 * the Stop hook's readers write it down so the stop can block on it.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFsGlob, makeWorkflowReader } from '../../src/deps/fs.js';
import {
  NOT_REGULAR_FILE,
  readRegularFile,
  readRegularFileSync,
  type ReadRefusals,
} from '../../src/deps/regular-file.js';
import { makeReceiptFs } from '../../src/surfaces/receipt-store.js';
import { makeFsSessionPinStore } from '../../src/surfaces/session-pin-store.js';

const CAN_MAKE_PIPES = process.platform !== 'win32';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'usabl-regular-file-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function pipe(path: string): void {
  execFileSync('mkfifo', [path]);
}

describe.skipIf(!CAN_MAKE_PIPES)('readRegularFile', () => {
  it('reads a regular file, and a link to one', async () => {
    await writeFile(join(root, 'a.txt'), 'token=SECRETPOISON\n');
    await symlink(join(root, 'a.txt'), join(root, 'link.txt'));

    expect((await readRegularFile(join(root, 'a.txt'))).toString('utf8')).toBe('token=SECRETPOISON\n');
    expect((await readRegularFile(join(root, 'link.txt'))).toString('utf8')).toBe('token=SECRETPOISON\n');
    expect(readRegularFileSync(join(root, 'a.txt')).toString('utf8')).toBe('token=SECRETPOISON\n');
  });

  it('fails as a plain read does for a missing path and a folder', async () => {
    await mkdir(join(root, 'folder'));

    await expect(readRegularFile(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readRegularFile(join(root, 'folder'))).rejects.toMatchObject({ code: 'EISDIR' });
    expect(() => readRegularFileSync(join(root, 'folder'))).toThrow(expect.objectContaining({ code: 'EISDIR' }));
  });

  it('refuses a named pipe and a link to one at once, and records the name it was given', async () => {
    pipe(join(root, 'pipe'));
    await symlink(join(root, 'pipe'), join(root, 'to-pipe'));
    const refusals: ReadRefusals = new Set();

    await expect(readRegularFile(join(root, 'pipe'), { name: 'pipe', refusals })).rejects.toMatchObject({
      code: NOT_REGULAR_FILE,
    });
    await expect(readRegularFile(join(root, 'to-pipe'), { name: 'to-pipe', refusals })).rejects.toMatchObject({
      code: NOT_REGULAR_FILE,
    });
    expect(() => readRegularFileSync(join(root, 'pipe'))).toThrow(expect.objectContaining({ code: NOT_REGULAR_FILE }));
    expect([...refusals].sort()).toEqual(['pipe', 'to-pipe']);
  });

  it('refuses a device', async () => {
    await expect(readRegularFile('/dev/zero')).rejects.toMatchObject({ code: NOT_REGULAR_FILE });
  });
});

describe.skipIf(!CAN_MAKE_PIPES)('the working-tree readers refuse a named pipe', () => {
  it('FsGlob readFile and readTextUpTo, recording the repository path', async () => {
    await mkdir(join(root, 'src'));
    pipe(join(root, 'src/Pipe.tsx'));
    const refusals: ReadRefusals = new Set();
    const fs = makeFsGlob({ cwd: root, refusals });

    await expect(fs.readFile('src/Pipe.tsx')).rejects.toMatchObject({ code: NOT_REGULAR_FILE });
    await expect(fs.readTextUpTo!('src/Pipe.tsx', 1024)).rejects.toMatchObject({ code: NOT_REGULAR_FILE });
    expect([...refusals]).toEqual(['src/Pipe.tsx']);
  });

  it('the workflow reader', async () => {
    pipe(join(root, 'workflow.yml'));

    await expect(makeWorkflowReader(root)('workflow.yml')).rejects.toMatchObject({ code: NOT_REGULAR_FILE });
  });

  it('the receipt store, for the receipt and the bypass file', async () => {
    await mkdir(join(root, '.usabl'));
    pipe(join(root, '.usabl/bypass-once'));
    pipe(join(root, '.usabl/receipt.json'));
    const refusals: ReadRefusals = new Set();
    const fs = makeReceiptFs(root, refusals);

    await expect(fs.readFile('.usabl/bypass-once')).rejects.toMatchObject({ code: NOT_REGULAR_FILE });
    await expect(fs.readFile('.usabl/receipt.json')).rejects.toMatchObject({ code: NOT_REGULAR_FILE });
    expect([...refusals].sort()).toEqual(['.usabl/bypass-once', '.usabl/receipt.json']);
  });

  it.skipIf(typeof process.getuid !== 'function')('the session pin store, as a stated refusal', async () => {
    const dir = join(root, 'pins');
    await mkdir(dir, { mode: 0o700 });
    pipe(join(dir, 's.json'));
    const store = makeFsSessionPinStore({ dir, uid: process.getuid!() });

    await expect(store.read('s.json')).resolves.toMatchObject({
      status: 'refused',
      reason: 'the session pin file is not a regular file',
    });
  });
});
