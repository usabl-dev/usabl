/**
 * A small zip writer for tests, and a stand-in for the GitHub artifact API.
 *
 * The writer can make the zips upload-artifact makes (deflate, a data descriptor, a Unix host) and
 * the hostile ones an artifact replaced in the run can carry: a .. segment in the middle of a name,
 * an absolute name, a symlink, a duplicate, an extra member, a local header that names something
 * else than the central directory, or a size that lies.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

export function crc32(data: Buffer): number {
  let c = -1;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  // 0 stored, 8 deflate. Deflate by default, as upload-artifact writes.
  method?: 0 | 8;
  // A Unix mode for the external attributes. A regular file by default.
  mode?: number;
  // The host byte of "version made by": 3 Unix by default.
  host?: number;
  // Write the sizes in a data descriptor after the data, as a streaming writer does.
  dataDescriptor?: boolean;
  // A different name in the local header than in the central directory.
  localName?: string;
  // Declare a different uncompressed size than the data has.
  declaredSize?: number;
  flags?: number;
}

export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const size = entry.declaredSize ?? data.length;
    const descriptor = entry.dataDescriptor ?? false;
    const flags = (entry.flags ?? 0x0800) | (descriptor ? 0x8 : 0);
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : body.length, 18);
    local.writeUInt32LE(descriptor ? 0 : size, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(0, 28);
    const parts = [local, localName, body];
    if (descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(size, 12);
      parts.push(dd);
    }
    const localRecord = Buffer.concat(parts);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((entry.host ?? 3) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    locals.push(localRecord);
    offset += localRecord.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export interface StoredArtifact {
  id: number;
  name: string;
  zip: Buffer;
}

export interface ArtifactApi {
  url: string;
  // Artifacts by run id.
  runs: Map<string, StoredArtifact[]>;
  // Every request the stand-in saw, with whether it carried a token.
  requests: Array<{ path: string; authorized: boolean }>;
  close(): Promise<void>;
}

function authorized(req: IncomingMessage): boolean {
  return req.headers.authorization === 'Bearer job-token';
}

// The REST API as the fetcher uses it: list a run's artifacts by name, then a zip download that
// redirects to signed storage, which takes no token.
export async function startArtifactApi(
  repository: string,
  // Where a run's artifacts come from, when they are not stored in the map.
  source?: (runId: string) => StoredArtifact[],
): Promise<ArtifactApi> {
  const runs = new Map<string, StoredArtifact[]>();
  const artifactsOf = (runId: string): StoredArtifact[] => source?.(runId) ?? runs.get(runId) ?? [];
  // A download names only the artifact id, so every artifact a listing showed is kept by id.
  const listed = new Map<number, StoredArtifact>();
  const requests: ArtifactApi['requests'] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ path: url.pathname, authorized: authorized(req) });
    const list = new RegExp(`^/repos/${repository}/actions/runs/(\\d+)/artifacts$`).exec(url.pathname);
    if (list !== null) {
      if (!authorized(req)) {
        res.writeHead(401).end();
        return;
      }
      const name = url.searchParams.get('name');
      const shown = artifactsOf(list[1] as string).filter((artifact) => name === null || artifact.name === name);
      for (const artifact of shown) listed.set(artifact.id, artifact);
      const artifacts = shown.map((artifact) => ({ id: artifact.id, name: artifact.name, size_in_bytes: artifact.zip.length, expired: false }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ total_count: artifacts.length, artifacts }));
      return;
    }
    const zip = new RegExp(`^/repos/${repository}/actions/artifacts/(\\d+)/zip$`).exec(url.pathname);
    if (zip !== null) {
      if (!authorized(req)) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(302, { location: `/storage/${zip[1]}?sig=signed` }).end();
      return;
    }
    const blob = /^\/storage\/(\d+)$/.exec(url.pathname);
    if (blob !== null) {
      const id = Number(blob[1]);
      const found = listed.get(id);
      if (found === undefined || req.headers.authorization !== undefined) {
        res.writeHead(found === undefined ? 404 : 400).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(found.zip.length) }).end(found.zip);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    runs,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let nextId = 1000;

// Put an artifact into a run the way upload-artifact does: a new id each time, the old one kept,
// so a replaced artifact is the newest one under its name.
export function storeArtifact(api: ArtifactApi, runId: string, name: string, zip: Buffer): StoredArtifact {
  nextId += 1;
  const artifact = { id: nextId, name, zip };
  api.runs.set(runId, [...(api.runs.get(runId) ?? []), artifact]);
  return artifact;
}
