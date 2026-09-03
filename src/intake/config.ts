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

// A budget of zero, a negative, a fraction, or a string would either fail every screen or fail
// deep inside a browser call. Refusing it here keeps the failure at config load, before a run
// launches anything.
function expectPositiveWholeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive whole number of milliseconds`);
  }
  return value;
}

// An empty reachedWhen would match nothing and mark every scan of the surface unseen, which is a
// silent failure hiding as coverage loss. Refuse it at config load so the operator fixes it before
// a run.
function parseReachedWhen(raw: unknown, index: number): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const selector = expectString(raw, `surfaces[${index}].reachedWhen`);
  if (selector.trim().length === 0) {
    throw new Error(`surfaces[${index}].reachedWhen must be a non-empty string`);
  }
  return selector;
}

function parseSurface(raw: unknown, index: number): SurfaceConfig {
  const surface = expectObject(raw, `surfaces[${index}]`);
  const reachedWhen = parseReachedWhen(Reflect.get(surface, 'reachedWhen'), index);
  return {
    id: expectString(Reflect.get(surface, 'id'), `surfaces[${index}].id`),
    url: expectString(Reflect.get(surface, 'url'), `surfaces[${index}].url`),
    files: expectStringArray(Reflect.get(surface, 'files'), `surfaces[${index}].files`),
    ...(reachedWhen === undefined ? {} : { reachedWhen }),
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

  const readyTimeoutRaw = Reflect.get(root, 'readyTimeoutMs');
  const readyTimeoutMs =
    readyTimeoutRaw === undefined
      ? undefined
      : expectPositiveWholeNumber(readyTimeoutRaw, 'readyTimeoutMs');

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
    ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
  };
}
