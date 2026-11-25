/**
 * Overlay filesystem reads for trusted-ref requirement intake.
 * This unit rewires requirements glob and file bytes only.
 * It must never decide verdicts or hide policy divergence.
 */
import type { FsGlob, GitReader, UsablConfig } from '../contracts/index.js';
import { matchGlob } from '../primitives/match-glob.js';
import { textWithin } from './file-size.js';

function stripTrailingSlashes(path: string): string {
  const stripped = path.replace(/\/+$/g, '');
  return stripped.length === 0 ? path : stripped;
}

function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function patternTargetsRoot(pattern: string, root: string): boolean {
  return pattern === root || pattern.startsWith(`${root}/`);
}

export function overlayRequirementsFs(
  fs: FsGlob,
  git: Pick<GitReader, 'lsFiles' | 'show'> & Partial<Pick<GitReader, 'blobSize'>>,
  config: Pick<UsablConfig, 'requirements'>,
  trustedRef: string | undefined,
): FsGlob {
  if (trustedRef === undefined || config.requirements === undefined) {
    return fs;
  }

  const root = stripTrailingSlashes(config.requirements);
  let trustedFilesPromise: Promise<string[]> | null = null;
  const trustedFiles = (): Promise<string[]> => {
    if (trustedFilesPromise === null) {
      trustedFilesPromise = git.lsFiles(trustedRef, root);
    }
    return trustedFilesPromise;
  };

  return {
    async glob(patterns) {
      const trustedPatterns = patterns.filter((pattern) => patternTargetsRoot(pattern, root));
      const workingPatterns = patterns.filter((pattern) => !patternTargetsRoot(pattern, root));
      const matches = new Set<string>();

      if (workingPatterns.length > 0) {
        for (const path of await fs.glob(workingPatterns)) {
          matches.add(path);
        }
      }

      // CI accessibility must read approved intake bytes, not PR edits still awaiting policy approval.
      if (trustedPatterns.length > 0) {
        for (const path of await trustedFiles()) {
          if (trustedPatterns.some((pattern) => matchGlob(pattern, path))) {
            matches.add(path);
          }
        }
      }

      return [...matches].sort();
    },
    async readFile(path) {
      if (isWithinRoot(path, root)) {
        return git.show(trustedRef, path);
      }
      return fs.readFile(path);
    },
    // A file at the trusted ref is sized from what git stores, before it is read, so the limit
    // counts the same bytes as on disk. A git reader with no size read is sized from its text.
    async readTextUpTo(path, maxBytes) {
      if (isWithinRoot(path, root)) {
        const size = git.blobSize === undefined ? null : await git.blobSize(trustedRef, path);
        if (size === null) {
          return textWithin(await git.show(trustedRef, path), maxBytes);
        }
        if (size > maxBytes) {
          return { kind: 'too-large' };
        }
        const text = await git.show(trustedRef, path);
        return text === null ? null : { kind: 'text', text };
      }
      return fs.readTextUpTo !== undefined ? fs.readTextUpTo(path, maxBytes) : textWithin(await fs.readFile(path), maxBytes);
    },
  };
}
