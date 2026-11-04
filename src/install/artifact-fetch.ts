/**
 * How a generated trusted job takes an artifact, and how it checks the engine before it runs it.
 *
 * Any job on a hosted runner that runs pull request code may be able to read the runner's own
 * token, and with it upload, replace, or delete any artifact of the run. So an artifact is hostile
 * input, and that includes its zip container, not just the file inside. actions/download-artifact
 * strips only a leading `../` from an entry name before it joins the name to the download folder,
 * so an entry like `nested/../../usabl-engine/dist/cli.js` writes outside that folder before any
 * digest is checked. No trusted job extracts an artifact with it.
 *
 * Instead a trusted job writes FETCH_ARTIFACT_SCRIPT, usabl's own fetcher, into its runner temp
 * directory and runs it with the job's own token. It finds the artifact through the REST API,
 * downloads the zip with a size bound, and reads the zip itself. It accepts only the exact member
 * names it was told to expect, each as a regular file, and refuses the whole artifact for any
 * other entry, a path anywhere in a name, an absolute name, a link or directory, a duplicate,
 * encryption, zip64, or a size over the bound. Every check runs on the central directory and the
 * local headers before a byte is written, and the files are written new into a fresh directory
 * outside the workspace. The digest check against the producing job's output comes after.
 *
 * The script uses Node builtins only, so it runs before the engine exists in the job.
 */

export const FETCHER_PATH = '${RUNNER_TEMP}/usabl-fetch-artifact.cjs';

// The bounds each artifact is fetched under. Each is far above what the artifact needs.
export const ARTIFACT_MAX_BYTES = {
  engine: 512 * 1024 ** 2,
  build: 2 * 1024 ** 3,
  result: 64 * 1024 ** 2,
  record: 64 * 1024 ** 2,
} as const;

export const FETCH_ARTIFACT_SCRIPT = `'use strict';
// usabl artifact fetcher. Node builtins only. It refuses an artifact rather than repair it.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

class Refusal extends Error {}
function refuse(message) {
  throw new Refusal(message);
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(chunk, previous) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(chunk, previous);
  let c = previous ^ -1;
  for (let i = 0; i < chunk.length; i += 1) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function settings(env) {
  const name = env.ARTIFACT_NAME || '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) refuse('ARTIFACT_NAME is not a plain artifact name');
  const members = (env.ARTIFACT_MEMBERS || '').split(',');
  for (const member of members) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(member) || member.includes('..')) {
      refuse('ARTIFACT_MEMBERS must list plain file names');
    }
  }
  if (new Set(members).size !== members.length) refuse('ARTIFACT_MEMBERS lists a name twice');
  const runId = env.ARTIFACT_RUN_ID || '';
  if (!/^[0-9]+$/.test(runId)) refuse('ARTIFACT_RUN_ID is not a run id');
  const maxBytes = Number(env.ARTIFACT_MAX_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) refuse('ARTIFACT_MAX_BYTES is not a byte count');
  const into = env.ARTIFACT_INTO || '';
  if (!path.isAbsolute(into) || path.resolve(into) !== into) refuse('ARTIFACT_INTO is not a plain absolute path');
  const workspace = env.GITHUB_WORKSPACE || '';
  if (workspace !== '') {
    const relative = path.relative(path.resolve(workspace), into);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      refuse('ARTIFACT_INTO must be outside the workspace');
    }
  }
  let api;
  try {
    api = new URL(env.GITHUB_API_URL || 'https://api.github.com');
  } catch {
    refuse('GITHUB_API_URL is not a URL');
  }
  if (api.protocol !== 'https:' && !(api.protocol === 'http:' && isLoopback(api.hostname))) {
    refuse('GITHUB_API_URL must be https');
  }
  const repository = env.GITHUB_REPOSITORY || '';
  if (!/^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(repository)) refuse('GITHUB_REPOSITORY is not owner/name');
  const token = env.GH_TOKEN || '';
  if (token === '') refuse('GH_TOKEN is empty');
  return { name, members, runId, maxBytes, into, api, repository, token };
}

function apiUrl(s, pathname) {
  return new URL(s.api.href.replace(/\\/$/, '') + pathname);
}

function apiHeaders(s) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + s.token,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'usabl',
  };
}

async function findArtifact(s) {
  const url = apiUrl(s, '/repos/' + s.repository + '/actions/runs/' + s.runId + '/artifacts?per_page=100&name=' + encodeURIComponent(s.name));
  const response = await fetch(url, { headers: apiHeaders(s), redirect: 'error' });
  if (!response.ok) refuse('GitHub answered ' + response.status + ' when listing the artifacts of run ' + s.runId);
  const listing = await response.json();
  const artifacts = listing !== null && typeof listing === 'object' && Array.isArray(listing.artifacts) ? listing.artifacts : [];
  // An artifact replaced in the run keeps its name and gets a new id, so the newest one is the one
  // the run holds now. Its content is checked against a job output after this.
  const found = artifacts
    .filter((a) => a !== null && typeof a === 'object' && a.name === s.name && a.expired !== true && Number.isSafeInteger(a.id))
    .sort((a, b) => b.id - a.id);
  if (found.length === 0) refuse('run ' + s.runId + ' has no artifact named ' + s.name);
  const artifact = found[0];
  if (typeof artifact.size_in_bytes === 'number' && artifact.size_in_bytes > s.maxBytes) {
    refuse('the artifact is ' + artifact.size_in_bytes + ' bytes, over the limit of ' + s.maxBytes);
  }
  return artifact.id;
}

async function download(s, id, zipPath) {
  const first = await fetch(apiUrl(s, '/repos/' + s.repository + '/actions/artifacts/' + id + '/zip'), {
    headers: apiHeaders(s),
    redirect: 'manual',
  });
  let response = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location');
    if (location === null) refuse('GitHub redirected the artifact download nowhere');
    const target = new URL(location, s.api);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && s.api.protocol === 'http:' && isLoopback(target.hostname))) {
      refuse('the artifact download was redirected to a URL that is not https');
    }
    if (first.body !== null) await first.body.cancel();
    // The storage URL is signed. The job token is never sent to it.
    response = await fetch(target, { redirect: 'error' });
  }
  if (!response.ok || response.body === null) refuse('the artifact download answered ' + response.status);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > s.maxBytes) refuse('the artifact zip is over the limit of ' + s.maxBytes + ' bytes');
  const out = await fsp.open(zipPath, 'wx', 0o600);
  let total = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      total += chunk.length;
      if (total > s.maxBytes) refuse('the artifact zip is over the limit of ' + s.maxBytes + ' bytes');
      await out.write(chunk);
    }
  } finally {
    await out.close();
  }
}

async function readAt(handle, offset, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  if (bytesRead !== length) refuse('the artifact zip ends early');
  return buffer;
}

// Why an entry name is refused, or null when it is exactly one of the expected members.
function nameRefusal(raw, members, seen) {
  let name;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return 'an entry name is not UTF-8';
  }
  const shown = JSON.stringify(name);
  if (name === '' || name.includes('\\0')) return 'an entry has an empty or NUL name';
  if (name.startsWith('/') || name.startsWith('\\\\') || /^[A-Za-z]:/.test(name)) return 'entry ' + shown + ' is an absolute path';
  if (name.split(/[\\\\/]/).includes('..')) return 'entry ' + shown + ' has a .. segment';
  if (name.includes('/') || name.includes('\\\\')) return 'entry ' + shown + ' is a path, not one of the expected file names';
  if (!members.includes(name)) return 'entry ' + shown + ' is not an expected member (' + members.join(', ') + ')';
  if (seen.has(name)) return 'entry ' + shown + ' appears twice';
  return null;
}

async function readEntries(handle, s) {
  const size = (await handle.stat()).size;
  if (size < 22) refuse('the artifact is not a zip archive');
  const tailLength = Math.min(size, 22 + 0xffff);
  const tailStart = size - tailLength;
  const tail = await readAt(handle, tailStart, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) refuse('the artifact is not a zip archive');
  const eocdOffset = tailStart + eocd;
  const disk = tail.readUInt16LE(eocd + 4);
  const cdDisk = tail.readUInt16LE(eocd + 6);
  const onDisk = tail.readUInt16LE(eocd + 8);
  const total = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) refuse('zip64 archives are not accepted');
  if (eocdOffset >= 20 && (await readAt(handle, eocdOffset - 20, 4)).readUInt32LE(0) === 0x07064b50) {
    refuse('zip64 archives are not accepted');
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) refuse('split zip archives are not accepted');
  if (total !== s.members.length) {
    refuse('the artifact has ' + total + ' entries, and it must hold exactly ' + s.members.join(', '));
  }
  if (cdOffset + cdSize !== eocdOffset || cdSize > 1024 * total) refuse('the zip central directory is malformed');
  const cd = await readAt(handle, cdOffset, cdSize);
  const entries = [];
  const seen = new Set();
  let p = 0;
  for (let i = 0; i < total; i += 1) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) refuse('the zip central directory is malformed');
    const entry = {
      madeBy: cd.readUInt16LE(p + 4),
      flags: cd.readUInt16LE(p + 8),
      method: cd.readUInt16LE(p + 10),
      crc: cd.readUInt32LE(p + 16),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      diskStart: cd.readUInt16LE(p + 34),
      external: cd.readUInt32LE(p + 38),
      offset: cd.readUInt32LE(p + 42),
    };
    const nameLength = cd.readUInt16LE(p + 28);
    const end = p + 46 + nameLength + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    if (end > cd.length) refuse('the zip central directory is malformed');
    entry.rawName = cd.subarray(p + 46, p + 46 + nameLength);
    const why = nameRefusal(entry.rawName, s.members, seen);
    if (why !== null) refuse(why);
    entry.name = entry.rawName.toString('utf8');
    seen.add(entry.name);
    if ((entry.flags & 0x2041) !== 0) refuse('entry ' + entry.name + ' is encrypted');
    if (entry.method !== 0 && entry.method !== 8) refuse('entry ' + entry.name + ' uses an unsupported compression method');
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff || entry.diskStart !== 0) {
      refuse('zip64 archives are not accepted');
    }
    const host = entry.madeBy >>> 8;
    const unixType = (entry.external >>> 16) & 0o170000;
    if (host === 3 && unixType !== 0 && unixType !== 0o100000) refuse('entry ' + entry.name + ' is not a regular file');
    if (host !== 3 && host !== 0) refuse('entry ' + entry.name + ' was made on a system whose file types are not checked');
    if ((entry.external & 0x10) !== 0) refuse('entry ' + entry.name + ' is a directory');
    if (entry.size > s.maxBytes) refuse('entry ' + entry.name + ' unpacks to ' + entry.size + ' bytes, over the limit of ' + s.maxBytes);
    if (entry.method === 0 && entry.compressedSize !== entry.size) refuse('entry ' + entry.name + ' has inconsistent sizes');
    if (entry.method === 8 && entry.compressedSize === 0) refuse('entry ' + entry.name + ' has inconsistent sizes');
    entries.push(entry);
    p = end;
  }
  if (p !== cd.length) refuse('the zip central directory is malformed');
  for (const entry of entries) {
    if (entry.offset + 30 > cdOffset) refuse('entry ' + entry.name + ' points outside the archive');
    const local = await readAt(handle, entry.offset, 30);
    const nameLength = local.readUInt16LE(26);
    const dataStart = entry.offset + 30 + nameLength + local.readUInt16LE(28);
    if (
      local.readUInt32LE(0) !== 0x04034b50 ||
      local.readUInt16LE(6) !== entry.flags ||
      local.readUInt16LE(8) !== entry.method ||
      dataStart + entry.compressedSize > cdOffset ||
      !(await readAt(handle, entry.offset + 30, nameLength)).equals(entry.rawName)
    ) {
      refuse('the local header of entry ' + entry.name + ' does not match the central directory');
    }
    if ((entry.flags & 0x8) === 0) {
      if (local.readUInt32LE(14) !== entry.crc || local.readUInt32LE(18) !== entry.compressedSize || local.readUInt32LE(22) !== entry.size) {
        refuse('the local header of entry ' + entry.name + ' does not match the central directory');
      }
    }
    entry.dataStart = dataStart;
  }
  return entries;
}

async function extract(handle, entry, into) {
  const target = path.join(into, entry.name);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const out = await fsp.open(target, flags, 0o600);
  let written = 0;
  let crc = 0;
  const count = new Transform({
    transform(chunk, _encoding, done) {
      written += chunk.length;
      if (written > entry.size) {
        done(new Refusal('entry ' + entry.name + ' unpacks to more than the ' + entry.size + ' bytes it declares'));
        return;
      }
      crc = crc32(chunk, crc);
      done(null, chunk);
    },
  });
  if (entry.compressedSize === 0) {
    await out.close();
  } else {
    const source = handle.createReadStream({ start: entry.dataStart, end: entry.dataStart + entry.compressedSize - 1, autoClose: false });
    const stages = entry.method === 8 ? [source, zlib.createInflateRaw(), count] : [source, count];
    await pipeline(...stages, out.createWriteStream());
  }
  if (written !== entry.size || crc !== entry.crc) refuse('entry ' + entry.name + ' does not match its declared size and checksum');
}

async function main() {
  const s = settings(process.env);
  const zipPath = s.into + '.zip';
  let created = false;
  try {
    const id = await findArtifact(s);
    await download(s, id, zipPath);
    const handle = await fsp.open(zipPath, 'r');
    try {
      const entries = await readEntries(handle, s);
      // A fresh directory: mkdir refuses one that already exists.
      await fsp.mkdir(s.into, { mode: 0o700 });
      created = true;
      for (const entry of entries) await extract(handle, entry, s.into);
    } finally {
      await handle.close();
    }
    console.log('usabl: fetched ' + s.members.join(', ') + ' from artifact ' + s.name + ' into ' + s.into);
  } catch (error) {
    if (created) await fsp.rm(s.into, { recursive: true, force: true });
    throw error;
  } finally {
    await fsp.rm(zipPath, { force: true });
  }
}

main().catch((error) => {
  const what = error instanceof Refusal ? error.message : 'the fetch failed: ' + (error instanceof Error ? error.message : String(error));
  console.error('usabl: refusing the ' + (process.env.ARTIFACT_NAME || '') + ' artifact: ' + what + '; failing closed');
  process.exit(1);
});`;

// The step that writes the fetcher. noclobber makes the write fail if anything already has the
// name, so the job runs the bytes this step wrote and nothing that was there before.
export function writeFetcherStep(): string {
  const body = FETCH_ARTIFACT_SCRIPT.split('\n')
    .map((line) => (line === '' ? '' : `          ${line}`))
    .join('\n');
  return `      - name: Write the artifact fetcher
        working-directory: \${{ runner.temp }}
        run: |
          # usabl's own artifact fetcher, Node builtins only. No trusted job extracts an artifact
          # with actions/download-artifact, whose zip extraction follows .. inside entry names.
          set -o noclobber
          cat > "${FETCHER_PATH}" <<'NODE'
${body}
          NODE`;
}

export interface FetchStep {
  stepName: string;
  artifact: string;
  member: string;
  // The directory name under the runner temp directory, for example usabl-download-build.
  into: string;
  maxBytes: number;
  // The run that holds the artifact, as an expression. This run unless the step says otherwise.
  runId?: string;
  // Extra shell after the fetch, at step depth, for example the digest check.
  then?: string;
  // Extra env entries, already formatted at env depth.
  env?: string;
}

export function fetchArtifactStep(step: FetchStep): string {
  return `      - name: ${step.stepName}
        working-directory: \${{ runner.temp }}
        env:
          GH_TOKEN: \${{ github.token }}
          ARTIFACT_NAME: ${step.artifact}
          ARTIFACT_MEMBERS: ${step.member}
          ARTIFACT_RUN_ID: ${step.runId ?? '${{ github.run_id }}'}
          ARTIFACT_MAX_BYTES: "${step.maxBytes}"
          ARTIFACT_INTO: \${{ runner.temp }}/${step.into}${step.env === undefined ? '' : `\n${step.env}`}
        run: |
          node "${FETCHER_PATH}"${step.then === undefined ? '' : `\n${step.then}`}`;
}

// A digest over the unpacked engine tree: every entry's type, path, and link target, then every
// regular file's sha256, in byte order. The engine job computes it on a fresh unpack of the archive
// it uploads, and every trusted job recomputes it right before it runs the engine, so a file the
// job's own steps changed after the archive check is caught.
export function engineTreeDigestCommand(dir: string): string {
  return `(cd "${dir}" && { find . -mindepth 1 -printf '%y %p %l\\n' | LC_ALL=C sort; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum; } | sha256sum | cut -d' ' -f1)`;
}

// The check a trusted step runs before it runs the engine. It needs ENGINE_TREE_DIGEST, the
// engine job's output, in env. It exits, so a step that must still publish an output runs it in a
// subshell.
export const ENGINE_CHECK = `          if ! [[ "\${ENGINE_TREE_DIGEST}" =~ ^[0-9a-f]{64}$ ]] || [ "$${engineTreeDigestCommand('${RUNNER_TEMP}/usabl-engine')}" != "\${ENGINE_TREE_DIGEST}" ]; then
            echo "the trusted engine tree is not the one the engine job packed; failing closed"
            exit 1
          fi`;
