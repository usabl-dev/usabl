/**
 * Overlay filesystem reads for trusted-ref requirement intake.
 * This unit rewires requirements glob and file bytes only.
 * It must never decide verdicts or hide policy divergence.
 */
import type { FsGlob, GitReader, UsablConfig } from '../contracts/index.js';
import { globUnderFolder, trimTrailingSlashes } from '../deps/fs-glob-reading.js';
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
    // The folder's name is read as plain text, never as a pattern. Under the requirements folder,
    // the trusted ref's files are listed and matched against the patterns below the folder.
    // Anywhere else the working tree is listed, with the requirements folder's files taken from the
    // trusted ref, as glob does.
    async globUnder(folder, patterns) {
      const under = trimTrailingSlashes(folder);
      const fromRef = async (): Promise<string[]> => {
        const prefix = under === '' ? '' : `${under}/`;
        return (await trustedFiles()).filter(
          (path) => path.startsWith(prefix) && patterns.some((pattern) => matchGlob(pattern, path.slice(prefix.length))),
        );
      };
      if (under !== '' && isWithinRoot(under, root)) {
        return (await fromRef()).sort();
      }
      const working = await globUnderFolder(fs, under, patterns);
      if (working === null) {
        throw new Error('usabl cannot list this folder: its name holds characters a glob reads as a pattern');
      }
      const merged = new Set(working.filter((path) => !isWithinRoot(path, root)));
      for (const path of await fromRef()) {
        if (isWithinRoot(path, root)) merged.add(path);
      }
      return [...merged].sort();
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
