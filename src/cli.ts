#!/usr/bin/env node
/**
 * Thin CLI over `run()`. Prints `formatSummary` and exits with `result.exitCode`.
 * Sample `usabl.config.json` URLs (`http://127.0.0.1:5173`) are the fixture app's
 * Vite origin, not a hardcoded engine target. The engine always reads operator config.
 */
import { readFile } from 'node:fs/promises';
import { run } from './run.js';
import { formatSummary } from './output/summary.js';
import type { SurfaceConfig, UsablConfig } from './contracts/index.js';
import { buildDeps } from './deps/build.js';

function expectObject(value: unknown, label: string): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function parseSurface(raw: unknown, index: number): SurfaceConfig {
  const surface = expectObject(raw, `surfaces[${index}]`);
  return {
    id: expectString(Reflect.get(surface, 'id'), `surfaces[${index}].id`),
    url: expectString(Reflect.get(surface, 'url'), `surfaces[${index}].url`),
    files: expectStringArray(Reflect.get(surface, 'files'), `surfaces[${index}].files`),
  };
}

function parseConfig(raw: string): UsablConfig {
  const parsed: unknown = JSON.parse(raw);
  const root = expectObject(parsed, 'config');
  const discovery = expectObject(Reflect.get(root, 'discovery'), 'discovery');
  const surfacesRaw = Reflect.get(root, 'surfaces');
  if (!Array.isArray(surfacesRaw)) {
    throw new Error('surfaces must be an array');
  }

  const requirementsRaw = Reflect.get(root, 'requirements');
  const requirements =
    requirementsRaw === undefined ? undefined : expectString(requirementsRaw, 'requirements');

  const promotedRaw = Reflect.get(root, 'promotedObligations');
  const promotedObligations =
    promotedRaw === undefined ? undefined : expectStringArray(promotedRaw, 'promotedObligations');

  return {
    appBaseUrl: expectString(Reflect.get(root, 'appBaseUrl'), 'appBaseUrl'),
    uiFileGlobs: expectStringArray(Reflect.get(root, 'uiFileGlobs'), 'uiFileGlobs'),
    discovery: {
      routerFile: expectString(Reflect.get(discovery, 'routerFile'), 'discovery.routerFile'),
      wideBlastGlobs: expectStringArray(Reflect.get(discovery, 'wideBlastGlobs'), 'discovery.wideBlastGlobs'),
    },
    surfaces: surfacesRaw.map((surface, index) => parseSurface(surface, index)),
    guardedPaths: expectStringArray(Reflect.get(root, 'guardedPaths'), 'guardedPaths'),
    ...(requirements === undefined ? {} : { requirements }),
    ...(promotedObligations === undefined ? {} : { promotedObligations }),
  };
}

async function loadConfig(path = 'usabl.config.json'): Promise<UsablConfig> {
  // Targets come from config so the same engine can run in local, CI, and preview environments.
  return parseConfig(await readFile(path, 'utf8'));
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? 'check';
  if (command !== 'check') {
    process.stderr.write(`unknown command: ${command}\n`);
    return 2;
  }
  const config = await loadConfig();
  const deps = await buildDeps(config);
  try {
    const result = await run(deps, config);
    process.stdout.write(formatSummary(result) + '\n');
    return result.exitCode;
  } finally {
    // Always close browser resources, even when run() throws before returning a Result.
    await deps.browser.close();
  }
}

// Only run when invoked directly as the bin.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // CLI entrypoint keeps run() fail-open semantics: disclose and exit 4, never silent green.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`usabl: ${message}\n`);
      process.exit(4);
    });
}
