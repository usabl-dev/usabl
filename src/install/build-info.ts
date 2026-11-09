/**
 * The engine pin `usabl install --ci` writes, read from the build record in dist/build-info.json.
 * scripts/write-build-info.mjs writes that record after each build: the package version, the
 * commit the build came from, and whether the tree was clean. The pin is a security value, so only
 * a full 40-character lowercase commit SHA from a clean tree counts. A missing record, a build
 * outside git, a dirty tree, or a record usabl cannot read keeps the placeholder and says why.
 * Nothing here reads the network: the commit is what this build says it is, and a commit that is
 * not on usabl-dev/usabl makes the engine checkout fail, which blocks the gate.
 */
import { readFile } from 'node:fs/promises';

export const BUILD_INFO_SCHEMA = 'usabl.build-info.v1';

export type EnginePin =
  | { kind: 'filled'; sha: string; version: string }
  | { kind: 'placeholder'; reason: string };

export const NO_BUILD_RECORD: EnginePin = {
  kind: 'placeholder',
  reason: 'this usabl has no build record (dist/build-info.json), so it cannot say which commit it was built from',
};

const UNREADABLE: EnginePin = {
  kind: 'placeholder',
  reason: 'this usabl has a build record (dist/build-info.json) that usabl cannot read',
};

export function enginePinFromBuildInfo(raw: string | null): EnginePin {
  if (raw === null) return NO_BUILD_RECORD;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNREADABLE;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return UNREADABLE;
  const schemaVersion: unknown = Reflect.get(parsed, 'schemaVersion');
  const version: unknown = Reflect.get(parsed, 'version');
  const commit: unknown = Reflect.get(parsed, 'commit');
  const clean: unknown = Reflect.get(parsed, 'clean');
  if (schemaVersion !== BUILD_INFO_SCHEMA || typeof version !== 'string' || typeof clean !== 'boolean') {
    return UNREADABLE;
  }
  if (commit === null) {
    return { kind: 'placeholder', reason: 'this usabl was built outside a git checkout, so it has no commit to pin' };
  }
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return UNREADABLE;
  if (!clean) {
    return {
      kind: 'placeholder',
      reason: 'this usabl was built from a tree with uncommitted changes, so its commit is not the code that was built',
    };
  }
  return { kind: 'filled', sha: commit, version };
}

/**
 * The pin for the running usabl. The record sits next to the bundled code in dist, so it is read
 * relative to this module. Run from source there is no record, and the placeholder is kept.
 */
export async function readEnginePin(): Promise<EnginePin> {
  let raw: string | null;
  try {
    raw = await readFile(new URL('./build-info.json', import.meta.url), 'utf8');
  } catch {
    raw = null;
  }
  return enginePinFromBuildInfo(raw);
}
