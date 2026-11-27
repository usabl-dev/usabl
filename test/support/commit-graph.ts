/**
 * Rewrites a commit-graph file so that one commit's first parent is another commit, with its
 * generation lifted above that commit's. git does not check the file's trailing hash when it reads
 * it, so this is what an agent that writes .git/objects/info/commit-graph can do without changing
 * any object.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export function patchCommitGraphParent(file: string, commit: string, parent: string): void {
  const buf = readFileSync(file);
  if (buf.toString('latin1', 0, 4) !== 'CGPH') throw new Error('not a commit-graph file');
  const idLength = buf[5] === 2 ? 32 : 20;
  const chunks = buf[6] ?? 0;
  const table = new Map<string, number>();
  for (let index = 0; index <= chunks; index += 1) {
    const at = 8 + index * 12;
    table.set(buf.toString('latin1', at, at + 4), Number(buf.readBigUInt64BE(at + 4)));
  }
  const fanout = table.get('OIDF') ?? 0;
  const count = buf.readUInt32BE(fanout + 255 * 4);
  const ids = table.get('OIDL') ?? 0;
  const position = (hex: string): number => {
    for (let index = 0; index < count; index += 1) {
      if (buf.toString('hex', ids + index * idLength, ids + (index + 1) * idLength) === hex) return index;
    }
    throw new Error(`the commit-graph does not hold ${hex}`);
  };
  const child = position(commit);
  const lifted = position(parent);
  const data = table.get('CDAT') ?? 0;
  const childEntry = data + child * (idLength + 16);
  const parentEntry = data + lifted * (idLength + 16);
  buf.writeUInt32BE(lifted, childEntry + idLength);
  const levelOf = (entry: number): number => buf.readUInt32BE(entry + idLength + 8) >>> 2;
  const word = buf.readUInt32BE(childEntry + idLength + 8);
  const level = Math.max(levelOf(childEntry), levelOf(parentEntry) + 1);
  buf.writeUInt32BE(((level << 2) | (word & 3)) >>> 0, childEntry + idLength + 8);
  const generations = table.get('GDA2');
  if (generations !== undefined) {
    const raised = Math.max(buf.readUInt32BE(generations + child * 4), buf.readUInt32BE(generations + lifted * 4) + 1);
    buf.writeUInt32BE(raised, generations + child * 4);
  }
  writeFileSync(file, buf);
}
