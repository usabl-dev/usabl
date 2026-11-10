// Stops a publish whose build record would make `usabl install --ci` write the engine pin
// placeholder. prepublishOnly runs it after `npm run check`, which rebuilds dist and its
// dist/build-info.json. The record must hold a full 40-character lowercase commit SHA and
// clean: true. A build from a tree with uncommitted or untracked changes records clean: false, and a
// build outside git records no commit; either would ship the placeholder to every user.
// This file holds the rule; scripts/check-release-build.ts runs it.

export const RECORD = 'dist/build-info.json';
const PREFIX = `usabl: refusing to publish: ${RECORD}`;
const PLACEHOLDER = 'so install --ci would write the engine pin placeholder';

/** Null when the record is fit for a release, otherwise the one line that says why not. */
export function releaseBuildProblem(raw: string | null): string | null {
  if (raw === null) return `${PREFIX} is missing. Run npm run build first.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Reflect.get(parsed, 'schemaVersion') !== 'usabl.build-info.v1') {
    return `${PREFIX} is not a build record usabl can read. Run npm run build again.`;
  }
  const commit: unknown = Reflect.get(parsed, 'commit');
  const clean: unknown = Reflect.get(parsed, 'clean');
  if (commit === null) {
    return `${PREFIX} says the build ran outside git, ${PLACEHOLDER}. Build from a git checkout of the release commit.`;
  }
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    return `${PREFIX} does not hold a full 40-character commit SHA, ${PLACEHOLDER}. Run npm run build again from a git checkout.`;
  }
  if (clean !== true) {
    return clean === false
      ? `${PREFIX} says the build came from a tree with uncommitted or untracked changes, ${PLACEHOLDER}. Commit or remove the changes, then run npm run build again.`
      : `${PREFIX} is not a build record usabl can read. Run npm run build again.`;
  }
  return null;
}
