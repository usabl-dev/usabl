/**
 * A release must not ship the placeholder engine pin. The pin comes from dist/build-info.json, and
 * a build from a dirty tree or outside git records no usable commit, so every user of that release
 * would get the placeholder. prepublishOnly runs this check after `npm run check` and stops the
 * publish with one plain line unless the record holds a full commit SHA and a clean tree.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { releaseBuildProblem } from '../../scripts/release-build.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const record = (fields: Record<string, unknown>): string =>
  JSON.stringify({ schemaVersion: 'usabl.build-info.v1', version: '0.3.0', commit: SHA, clean: true, ...fields });

describe('releaseBuildProblem', () => {
  it('passes a record with a full commit SHA from a clean tree', () => {
    expect(releaseBuildProblem(record({}))).toBeNull();
  });

  it('stops a dirty tree, a build outside git, or a commit that is not a full SHA', () => {
    for (const fields of [{ clean: false }, { commit: null }, { commit: SHA.slice(0, 7) }, { commit: SHA.toUpperCase() }, { commit: `${SHA}\n` }, { clean: 'true' }]) {
      const problem = releaseBuildProblem(record(fields));
      expect(problem, JSON.stringify(fields)).not.toBeNull();
      // One plain line.
      expect(problem).not.toContain('\n');
    }
  });

  it('stops a missing or unreadable record', () => {
    for (const raw of [null, '', 'not json', '[]', JSON.stringify({ commit: SHA, clean: true })]) {
      expect(releaseBuildProblem(raw), String(raw)).not.toBeNull();
    }
  });

  it('says what a dirty tree does', () => {
    expect(releaseBuildProblem(record({ clean: false }))).toBe(
      'usabl: refusing to publish: dist/build-info.json says the build came from a tree with uncommitted or untracked changes, so install --ci would write the engine pin placeholder. Commit or remove the changes, then run npm run build again.',
    );
  });
});

describe('prepublishOnly', () => {
  it('runs the full check and then the release build check', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['prepublishOnly']).toBe('npm run check && vite-node scripts/check-release-build.ts');
  });
});
