/**
 * readLocalFile tells the receipt what is at a path git may not see: nothing, a regular file and
 * the hash of its bytes, or something else that usabl does not read as a file of the repository.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFsGlob } from '../../src/deps/fs.js';

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
  it('reads a regular file as its sha256 hash, never its bytes', async () => {
    const read = await makeFsGlob({ cwd: root }).readLocalFile!('public/generated.js');
    expect(read).toEqual({ kind: 'file', sha256: createHash('sha256').update('one').digest('hex') });
  });

  it('reads nothing there as missing, also below a file', async () => {
    const fs = makeFsGlob({ cwd: root });
    await expect(fs.readLocalFile!('public/none.js')).resolves.toEqual({ kind: 'missing' });
    await expect(fs.readLocalFile!('none/none.js')).resolves.toEqual({ kind: 'missing' });
    await expect(fs.readLocalFile!('public/generated.js/below')).resolves.toEqual({ kind: 'missing' });
  });

  it('reads a folder, a link, and a path below a linked folder as other', async () => {
    await symlink(join(outside, 'shared.env'), join(root, '.env'));
    await symlink(outside, join(root, 'linked'));
    const fs = makeFsGlob({ cwd: root });
    await expect(fs.readLocalFile!('public')).resolves.toEqual({ kind: 'other' });
    await expect(fs.readLocalFile!('.env')).resolves.toEqual({ kind: 'other' });
    await expect(fs.readLocalFile!('linked/shared.env')).resolves.toEqual({ kind: 'other' });
  });

  it.skipIf(process.getuid?.() === 0)('reads a file it may not open as other', async () => {
    await chmod(join(root, 'public', 'generated.js'), 0o000);
    await expect(makeFsGlob({ cwd: root }).readLocalFile!('public/generated.js')).resolves.toEqual({ kind: 'other' });
  });

  it('lists ignored dot files that start with .env', async () => {
    await writeFile(join(root, '.env'), 'A=1\n');
    await writeFile(join(root, '.env.local'), 'B=2\n');
    await writeFile(join(root, '.gitignore'), '.env*\n');
    await expect(makeFsGlob({ cwd: root }).glob(['.env*'])).resolves.toEqual(['.env', '.env.local']);
  });
});
