/**
 * Reads and parses usabl.config.json for a command or a surface.
 *
 * It lives apart from the CLI so a surface that needs the config, such as the stop hook or the
 * overlay host, does not load every command the CLI holds. The CLI re-exports it.
 * This unit reads config only. It must never decide a verdict.
 */
import { readFile, stat } from 'node:fs/promises';
import type { UsablConfig } from '../contracts/index.js';
import { configUrlWarningsByUrl, parseUsablConfig } from './config.js';
import { operatorText } from './config-error.js';

// The configured url warnings this process has already printed. It holds config urls, which may
// carry a query, so it is never printed and never leaves the process.
const warnedConfigUrls = new Set<string>();

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

const DEFAULT_CONFIG_PATH = 'usabl.config.json';

export async function loadConfig(
  path = DEFAULT_CONFIG_PATH,
  warn: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
  // The docs manifest the run reads, from the folder usabl runs in. Its presence is what lets a
  // config with no UI globs load. Tests pass a path of their own.
  docsManifestPath = 'usabl.docs.json',
): Promise<UsablConfig> {
  // Targets come from config so the same engine can run in local, CI, and preview environments.
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      // The first error a new user meets. Name the command that writes the file. A path other than
      // the default came from --config, so telling that reader to pass --config would repeat what
      // they did.
      throw new Error(
        path === DEFAULT_CONFIG_PATH
          ? `${path} not found. Run "usabl init" to draft it, or pass --config <path>.`
          : `${operatorText(path)} not found. Check the path given to --config, or run "usabl init" to draft ${DEFAULT_CONFIG_PATH}.`,
      );
    }
    throw error;
  }
  const config = parseConfigText(raw, warn);
  if (config.uiFileGlobs.length === 0 && !(await fileExists(docsManifestPath))) {
    throw new Error(emptyUiFileGlobsRefusal(path));
  }
  return config;
}

/**
 * Why a config with no UI globs is refused. With none, no changed file is a UI file, so every run
 * reads as nothing to check and exits 0, which reads like a pass on a run that looked at nothing.
 * A documentation-only repository has no UI files, and its usabl.docs.json says what to check, so
 * that shape still loads.
 */
export function emptyUiFileGlobsRefusal(path: string): string {
  return (
    `${operatorText(path)} has an empty uiFileGlobs list, so usabl would read no change as a UI change, ` +
    'and every run would say nothing to check without looking at anything. usabl did not run. ' +
    'Set uiFileGlobs to the files that render your UI, such as src/**/*.tsx. ' +
    'If this repository holds documentation only, add usabl.docs.json, which "usabl init --docs" drafts.'
  );
}

// A manifest usabl cannot even look at is not proof of a documentation-only repository.
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse config text that was already read, with the same checks and warnings as loadConfig. The
 * Stop hook reads the bytes itself, compares them with the last commit, and parses only the bytes
 * it compared, so the file is never read twice.
 */
export function parseConfigText(
  raw: string,
  warn: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): UsablConfig {
  const config = parseUsablConfig(raw);
  // A configured URL with a query or a fragment loads, and the operator is told where it is
  // printed. Once per process for each field and url: the dev-server plugin loads the config on
  // every save, and the same warning on every save buries the output it sits in.
  for (const { url, warning } of configUrlWarningsByUrl(config)) {
    const key = `${warning}\u0000${url}`;
    if (!warnedConfigUrls.has(key)) {
      warnedConfigUrls.add(key);
      warn(warning);
    }
  }
  return config;
}
