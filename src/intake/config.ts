/**
 * Parse operator usabl.config.json into UsablConfig.
 * This unit validates shape only.
 * It must never mint a verdict or choose scan targets on its own.
 */
import type { SurfaceConfig, UsablConfig } from '../contracts/index.js';

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

export function parseUsablConfig(raw: string): UsablConfig {
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
