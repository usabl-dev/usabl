/**
 * readLocalFile tells the receipt what is at a path git may not see: nothing, a regular file and
 * the hash of its bytes, or something else that usabl does not read as a file of the repository.
 * A file larger than the cap it is given is something else too, and its bytes are never read.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFsGlob } from '../../src/deps/fs.js';

const MIB = 1024 * 1024;

let root = '';
let outside = '';

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'usabl-local-file-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'usabl-local-file-outside-')));
  await mkdir(join(root, 'public'), { recursive: true });
  await writeFile(join(root, 'public', 'generated.js'), 'one');
  await writeFile(join(outside, 'shared.env'), 'A=1\n');
});

afterEach(async () => {
  await chmod(join(root, 'public', 'generated.js'), 0o644).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('makeFsGlob readLocalFile', () => {
  it('reads a regular file as its sha256 hash and its size, never its bytes', async () => {
    const read = await makeFsGlob({ cwd: root }).readLocalFile!('public/generated.js', MIB);
    expect(read).toEqual({ kind: 'file', sha256: createHash('sha256').update('one').digest('hex'), size: 3 });
  });

  it('reads nothing there as missing, also below a file', async () => {
    const fs = makeFsGlob({ cwd: root });
    await expect(fs.readLocalFile!('public/none.js', MIB)).resolves.toEqual({ kind: 'missing' });
    await expect(fs.readLocalFile!('none/none.js', MIB)).resolves.toEqual({ kind: 'missing' });
    await expect(fs.readLocalFile!('public/generated.js/below', MIB)).resolves.toEqual({ kind: 'missing' });
  });

  it('reads a folder, a link, and a path below a linked folder as other', async () => {
    await symlink(join(outside, 'shared.env'), join(root, '.env'));
    await symlink(outside, join(root, 'linked'));
    const fs = makeFsGlob({ cwd: root });
    await expect(fs.readLocalFile!('public', MIB)).resolves.toEqual({ kind: 'other' });
    await expect(fs.readLocalFile!('.env', MIB)).resolves.toEqual({ kind: 'other' });
    await expect(fs.readLocalFile!('linked/shared.env', MIB)).resolves.toEqual({ kind: 'other' });
  });

  it.skipIf(process.getuid?.() === 0)('reads a file it may not open as other', async () => {
    await chmod(join(root, 'public', 'generated.js'), 0o000);
    await expect(makeFsGlob({ cwd: root }).readLocalFile!('public/generated.js', MIB)).resolves.toEqual({
      kind: 'other',
    });
  });

  it('reads a file over the cap as other, and a file at the cap as a file', async () => {
    await writeFile(join(root, '.env.at'), Buffer.alloc(MIB, 0x61));
    await writeFile(join(root, '.env.over'), Buffer.alloc(MIB + 1, 0x61));
    const fs = makeFsGlob({ cwd: root });
    await expect(fs.readLocalFile!('.env.at', MIB)).resolves.toMatchObject({ kind: 'file', size: MIB });
    await expect(fs.readLocalFile!('.env.over', MIB)).resolves.toEqual({ kind: 'other' });
  });

  it('refuses a large sparse file by its size, without reading it', async () => {
    // A sparse file uses no disk, so any size is free to make. Hashing 4 GiB takes many seconds.
    await writeFile(join(root, '.env.big'), '');
    await truncate(join(root, '.env.big'), 4 * 1024 * MIB);
    const started = performance.now();
    const read = await makeFsGlob({ cwd: root }).readLocalFile!('.env.big', 16 * MIB);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(read).toEqual({ kind: 'other' });
  });

  // A file in /proc says its size is 0 and then gives bytes when read, the same as a file that grows
  // after the size was read. More bytes than the size said is something usabl did not read whole.
  it.skipIf(process.platform !== 'linux')('reads a file that gives more bytes than its size said as other', async () => {
    const fs = makeFsGlob({ cwd: '/proc/self' });
    await expect(fs.readLocalFile!('status', MIB)).resolves.toEqual({ kind: 'other' });
  });

  it('lists ignored dot files that start with .env', async () => {
    await writeFile(join(root, '.env'), 'A=1\n');
    await writeFile(join(root, '.env.local'), 'B=2\n');
    await writeFile(join(root, '.gitignore'), '.env*\n');
    await expect(makeFsGlob({ cwd: root }).glob(['.env*'])).resolves.toEqual(['.env', '.env.local']);
  });
});
