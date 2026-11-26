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
  git: Pick<GitReader, 'lsFiles' | 'show'> & Partial<Pick<GitReader, 'blobSize' | 'commitOf'>>,
  config: Pick<UsablConfig, 'requirements'>,
  trustedRef: string | undefined,
): FsGlob {
  if (trustedRef === undefined || config.requirements === undefined) {
    return fs;
  }

  const root = stripTrailingSlashes(config.requirements);
  // The trusted ref is read as one commit id, found once, for the listing, the sizes and the texts.
  // A branch name read by name in each git call could move between the size read and the text
  // read, and then the byte limit would count one file and load another. A ref that names no
  // commit, or a reader that cannot say, is read by its name, so git gives the same errors as before.
  let pinnedRefPromise: Promise<string> | null = null;
  const pinnedRef = (): Promise<string> => {
    if (pinnedRefPromise === null) {
      pinnedRefPromise =
        git.commitOf === undefined ? Promise.resolve(trustedRef) : git.commitOf(trustedRef).then((id) => id ?? trustedRef);
    }
    return pinnedRefPromise;
  };
  let trustedFilesPromise: Promise<string[]> | null = null;
  const trustedFiles = (): Promise<string[]> => {
    if (trustedFilesPromise === null) {
      trustedFilesPromise = pinnedRef().then((ref) => git.lsFiles(ref, root));
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
        return git.show(await pinnedRef(), path);
      }
      return fs.readFile(path);
    },
    // A file at the trusted ref is sized from what git stores, before it is read, so the limit
    // counts the same bytes as on disk. A git reader with no size read is sized from its text.
    async readTextUpTo(path, maxBytes) {
      if (isWithinRoot(path, root)) {
        const ref = await pinnedRef();
        const size = git.blobSize === undefined ? null : await git.blobSize(ref, path);
        if (size === null) {
          return textWithin(await git.show(ref, path), maxBytes);
        }
        if (size > maxBytes) {
          return { kind: 'too-large' };
        }
        const text = await git.show(ref, path);
        return text === null ? null : { kind: 'text', text };
      }
      return fs.readTextUpTo !== undefined ? fs.readTextUpTo(path, maxBytes) : textWithin(await fs.readFile(path), maxBytes);
    },
  };
}
