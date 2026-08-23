/**
 * Real GitReader adapter backed by git CLI commands.
 * This unit reports repository facts only and must never decide coverage or verdicts.
 * Missing HEAD blobs return null so the guard can disclose not-covered work honestly.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitReader } from '../contracts/index.js';

const execFileAsync = promisify(execFile);
const STATUS_ENTRY_SEPARATOR = '\0';
const MISSING_SHOW_PATTERNS = [
  /does not exist in/i,
  /exists on disk, but not in/i,
  /pathspec .* did not match/i,
];

function readErrorCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) {
    return null;
  }
  const code = Reflect.get(err, 'code');
  return typeof code === 'number' ? code : null;
}

function readErrorStderr(err: unknown): string {
  if (typeof err !== 'object' || err === null) {
    return '';
  }
  const stderr = Reflect.get(err, 'stderr');
  return typeof stderr === 'string' ? stderr : '';
}

function isMissingShow(stderr: string): boolean {
  return MISSING_SHOW_PATTERNS.some((pattern) => pattern.test(stderr));
}

function parseStatus(output: string): Array<{ code: string; path: string }> {
  const parsed: Array<{ code: string; path: string }> = [];
  const entries = output.split(STATUS_ENTRY_SEPARATOR).filter((entry) => entry.length > 0);

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] ?? '';
    const status = entry.slice(0, 2);
    const statusCode = status.trim();
    const sourcePath = entry.slice(3);
    if (statusCode.length === 0) {
      continue;
    }

    const renameOrCopy = status.includes('R') || status.includes('C');
    if (renameOrCopy) {
      const targetPath = entries[i + 1];
      if (typeof targetPath === 'string' && targetPath.length > 0) {
        parsed.push({ code: statusCode, path: targetPath });
        i += 1;
        continue;
      }
    }

    parsed.push({ code: statusCode, path: sourcePath });
  }

  return parsed;
}

function parseLsTree(output: string): Record<string, string> {
  const blobs: Record<string, string> = {};
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const [meta, path] = line.split('\t');
    if (meta === undefined || path === undefined) {
      continue;
    }
    const parts = meta.trim().split(/\s+/);
    const sha = parts[2];
    if (sha !== undefined) {
      blobs[path] = sha;
    }
  }
  return blobs;
}

function parseLsFiles(output: string): string[] {
  const files = new Set<string>();
  for (const line of output.split('\n')) {
    const path = line.trim();
    if (path.length > 0) {
      files.add(path);
    }
  }
  return [...files].sort();
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export function makeGitReader(options: { cwd?: string } = {}): GitReader {
  const cwd = options.cwd ?? process.cwd();

  return {
    async statusZ() {
      const output = await runGit(cwd, ['status', '--porcelain', '-z']);
      return parseStatus(output);
    },
    async show(ref, path) {
      try {
        const output = await runGit(cwd, ['show', `${ref}:${path}`]);
        return output;
      } catch (err) {
        const code = readErrorCode(err);
        const stderr = readErrorStderr(err);
        if (code !== null && isMissingShow(stderr)) {
          return null;
        }
        throw err;
      }
    },
    async lsTree(ref, paths) {
      if (paths.length === 0) {
        return {};
      }
      const output = await runGit(cwd, ['ls-tree', ref, '--', ...paths]);
      return parseLsTree(output);
    },
    async lsFiles(ref, prefix) {
      const output = await runGit(cwd, ['ls-tree', '-r', '--name-only', ref, '--', prefix]);
      return parseLsFiles(output);
    },
    async writeTree() {
      return (await runGit(cwd, ['write-tree'])).trim();
    },
    async headRef() {
      return (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
    },
  };
}
