/**
 * Real FsGlob adapter for file reads and glob expansion.
 * This unit reports filesystem state only and must never infer coverage outcomes.
 * Missing files return null so callers can disclose not-covered work without guessing.
 */
import { glob, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FsGlob } from '../contracts/index.js';

function isMissingFile(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = Reflect.get(err, 'code');
  return code === 'ENOENT';
}

export function makeFsGlob(options: { cwd?: string } = {}): FsGlob {
  const cwd = options.cwd ?? process.cwd();

  return {
    async readFile(path) {
      try {
        return await readFile(resolve(cwd, path), 'utf8');
      } catch (err) {
        if (isMissingFile(err)) {
          return null;
        }
        throw err;
      }
    },
    async glob(patterns) {
      const seen = new Set<string>();
      for (const pattern of patterns) {
        for await (const match of glob(pattern, { cwd })) {
          seen.add(match);
        }
      }
      return [...seen].sort();
    },
  };
}
