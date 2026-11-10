/**
 * Reads and parses usabl.config.json for a command or a surface.
 *
 * It lives apart from the CLI so a surface that needs the config, such as the stop hook or the
 * overlay host, does not load every command the CLI holds. The CLI re-exports it.
 * This unit reads config only. It must never decide a verdict.
 */
import { readFile } from 'node:fs/promises';
import type { UsablConfig } from '../contracts/index.js';
import { configUrlWarningsByUrl, parseUsablConfig } from './config.js';

// The configured url warnings this process has already printed. It holds config urls, which may
// carry a query, so it is never printed and never leaves the process.
const warnedConfigUrls = new Set<string>();

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

export async function loadConfig(
  path = 'usabl.config.json',
  warn: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): Promise<UsablConfig> {
  // Targets come from config so the same engine can run in local, CI, and preview environments.
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      // The first error a new user meets. Name the command that writes the file.
      throw new Error(`${path} not found. Run "usabl init" to draft it, or pass --config <path>.`);
    }
    throw error;
  }
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
