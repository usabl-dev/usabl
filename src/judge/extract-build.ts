/**
 * `usabl extract-build`: unpack the build archive for the trusted judge.
 *
 * The archive was produced by a job that ran pull request code, so its member list is hostile
 * input. Handing it to a general-purpose tar would trust that tool's defenses against links,
 * absolute names, and `..` segments, which differ by version and flags. Instead this reads the
 * tar headers itself, checks every member before writing anything, and then writes the files
 * itself into a fresh, empty directory:
 *
 * - regular files and directories only; a symlink, hard link, device, FIFO, or any other
 *   member type refuses the whole archive,
 * - no absolute path and no `..` segment,
 * - every file is created new (it can never replace or follow something already there), and
 *   nothing but files and directories is ever created, so no write can pass through a link.
 *
 * It reads POSIX ustar, GNU long names, and pax path records, which is what GNU tar writes. It
 * never decides a verdict; it only refuses or unpacks.
 */
import { mkdir, open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const BLOCK = 512;

interface Member {
  path: string;
  kind: 'file' | 'directory';
  dataOffset: number;
  size: number;
}

export type ExtractOutcome = { ok: true; files: number } | { ok: false; message: string };

function readString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

function readOctal(block: Buffer, start: number, length: number): number | null {
  // A set high bit marks the base-256 form tar uses for sizes past 8 GiB. A build that large is
  // not a web app, so it is refused rather than parsed.
  if (((block[start] ?? 0) & 0x80) !== 0) {
    return null;
  }
  const text = readString(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) {
    return null;
  }
  return text === '' ? 0 : parseInt(text, 8);
}

function checksumMatches(block: Buffer): boolean {
  const recorded = readOctal(block, 148, 8);
  if (recorded === null) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    // The checksum field itself counts as eight spaces.
    sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  }
  return sum === recorded;
}

// pax records are "<length> <key>=<value>\n". Only path and size change how a member is read.
function parsePax(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(data.subarray(offset, space).toString('utf8'));
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) {
      throw new Error('a pax header record is malformed');
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) {
      records[record.slice(0, equals)] = record.slice(equals + 1);
    }
    offset += length;
  }
  return records;
}

// Turn a member name into a path relative to the destination, or say why it is refused. The
// archive's own root entry ("./") normalizes to the empty path.
function normalizeMemberPath(name: string): { ok: true; path: string } | { ok: false; message: string } {
  if (name.startsWith('/')) {
    return { ok: false, message: `member ${JSON.stringify(name)} is an absolute path` };
  }
  const segments: string[] = [];
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      return { ok: false, message: `member ${JSON.stringify(name)} has a .. segment` };
    }
    segments.push(segment);
  }
  return { ok: true, path: segments.join('/') };
}

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  if (bytesRead !== length) {
    throw new Error('the archive ends in the middle of a member');
  }
  return buffer;
}

const TYPE_NAMES: Record<string, string> = {
  '1': 'a hard link',
  '2': 'a symbolic link',
  '3': 'a character device',
  '4': 'a block device',
  '6': 'a FIFO',
  K: 'a long link name',
};

// Read and check every header. Nothing is written until this returns a full, clean list.
async function listMembers(handle: FileHandle, archiveSize: number): Promise<Member[]> {
  const members: Member[] = [];
  let offset = 0;
  let longName: string | null = null;
  let pax: Record<string, string> | null = null;
  for (;;) {
    if (offset + BLOCK > archiveSize) {
      throw new Error('the archive ends before its end-of-archive marker');
    }
    const header = await readAt(handle, offset, BLOCK);
    if (header.every((byte) => byte === 0)) {
      return members;
    }
    if (!checksumMatches(header)) {
      throw new Error('a header checksum does not match, so this is not a tar archive or it is damaged');
    }
    const size = readOctal(header, 124, 12);
    if (size === null) {
      throw new Error('a member size is unreadable');
    }
    const type = String.fromCharCode(header[156] ?? 0);
    const dataOffset = offset + BLOCK;
    const next = dataOffset + Math.ceil(size / BLOCK) * BLOCK;
    if (dataOffset + size > archiveSize) {
      throw new Error('the archive ends in the middle of a member');
    }

    if (type === 'L') {
      longName = readString(await readAt(handle, dataOffset, size), 0, size);
      offset = next;
      continue;
    }
    if (type === 'x') {
      pax = parsePax(await readAt(handle, dataOffset, size));
      offset = next;
      continue;
    }

    const magic = header.subarray(257, 263).toString('latin1');
    const prefix = magic === 'ustar\0' ? readString(header, 345, 155) : '';
    const plainName = readString(header, 0, 100);
    const name = pax?.['path'] ?? longName ?? (prefix === '' ? plainName : `${prefix}/${plainName}`);
    const memberSize = pax?.['size'] === undefined ? size : Number(pax['size']);
    longName = null;
    pax = null;

    if (type !== '0' && type !== '\0' && type !== '5') {
      const what = TYPE_NAMES[type] ?? `a member of type ${JSON.stringify(type)}`;
      throw new Error(`member ${JSON.stringify(name)} is ${what}; only regular files and directories are allowed, so no link can be unpacked`);
    }
    const normalized = normalizeMemberPath(name);
    if (!normalized.ok) {
      throw new Error(normalized.message);
    }
    if (type === '5') {
      if (normalized.path !== '') {
        members.push({ path: normalized.path, kind: 'directory', dataOffset, size: 0 });
      }
    } else {
      if (normalized.path === '') {
        throw new Error('a file member has no name');
      }
      if (!Number.isInteger(memberSize) || memberSize !== size) {
        throw new Error(`member ${JSON.stringify(name)} has an inconsistent size`);
      }
      members.push({ path: normalized.path, kind: 'file', dataOffset, size: memberSize });
    }
    offset = next;
  }
}

async function copyData(handle: FileHandle, member: Member, target: string): Promise<void> {
  // "wx" creates the file and fails if anything already has that name, so a member can never
  // replace or write through an existing entry.
  const out = await open(target, 'wx', 0o644);
  try {
    const chunk = 1024 * 1024;
    for (let done = 0; done < member.size; done += chunk) {
      const length = Math.min(chunk, member.size - done);
      await out.write(await readAt(handle, member.dataOffset + done, length));
    }
  } finally {
    await out.close();
  }
}

export async function extractBuildArchive(archivePath: string, into: string): Promise<ExtractOutcome> {
  let handle: FileHandle;
  try {
    handle = await open(archivePath, 'r');
  } catch (error) {
    return { ok: false, message: `cannot open the archive: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const archiveSize = (await handle.stat()).size;
    let members: Member[];
    try {
      members = await listMembers(handle, archiveSize);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    await mkdir(into, { recursive: true });
    const info = await stat(into);
    if (!info.isDirectory() || (await readdir(into)).length > 0) {
      return { ok: false, message: `the destination ${into} must be a fresh, empty directory` };
    }
    let files = 0;
    for (const member of members) {
      const target = join(into, member.path);
      if (member.kind === 'directory') {
        await mkdir(target, { recursive: true, mode: 0o755 });
        continue;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await copyData(handle, member, target);
      files += 1;
    }
    return { ok: true, files };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle.close();
  }
}

export interface ExtractBuildIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** CLI command. Exit 0 unpacked, 1 refused, 2 bad arguments. */
export async function runExtractBuild(argv: string[], io: ExtractBuildIo): Promise<number> {
  let archive: string | null = null;
  let into: string | null = null;
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if ((token !== '--archive' && token !== '--into') || value === undefined || value.startsWith('--')) {
      io.stderr('usabl: extract-build takes --archive <tar file> --into <fresh directory>\n');
      return 2;
    }
    if (token === '--archive') archive = value;
    if (token === '--into') into = value;
  }
  if (archive === null || into === null) {
    io.stderr('usabl: extract-build takes --archive <tar file> --into <fresh directory>\n');
    return 2;
  }
  const outcome = await extractBuildArchive(archive, into);
  if (!outcome.ok) {
    io.stderr(`usabl: refusing the build archive: ${outcome.message}\n`);
    return 1;
  }
  io.stdout(`usabl: unpacked ${outcome.files} file(s) into ${into}\n`);
  return 0;
}
