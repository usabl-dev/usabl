/**
 * This repository guards the files that hold its verdict rules. The verdict precedence and the
 * exit codes live in src/coverage/completeness.ts, and the CI approval decision lives in
 * src/surfaces/policy-enforce.ts. Both are outside the guarded folders, so they are listed in this
 * repository's own config and CODEOWNERS. They are not in the built-in list, which every team's
 * repository gets.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { compileCodeownersPattern } from '../../src/primitives/match-codeowners.js';
import { buildGuardedSet, checkGuard } from '../../src/trust/guard.js';

const VERDICT_RULE_FILES = ['src/coverage/completeness.ts', 'src/surfaces/policy-enforce.ts'];

async function repoFile(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe("this repository's verdict rule files", () => {
  for (const path of VERDICT_RULE_FILES) {
    it(`reports a change to ${path} as a guarded change`, async () => {
      const configBytes = await repoFile('usabl.config.json');
      const config = JSON.parse(configBytes) as UsablConfig;
      const deps = makeFakeDeps({
        files: { 'usabl.config.json': configBytes, [path]: 'changed rules\n' },
        headContents: { 'usabl.config.json': configBytes, [path]: 'committed rules\n' },
      });
      await expect(checkGuard(deps, config)).resolves.toEqual([path]);
    });

    it(`gives ${path} an explicit owner rule in CODEOWNERS`, async () => {
      const codeowners = await repoFile('.github/CODEOWNERS');
      const owned = codeowners.split('\n').some((line) => {
        const [pattern = '', owner] = line.replace(/#.*$/, '').trim().split(/\s+/);
        const compiled = compileCodeownersPattern(pattern);
        return pattern !== '*' && owner !== undefined && compiled.ok && compiled.state(path) === 'match';
      });
      expect(owned).toBe(true);
    });
  }

  it('adds nothing to the built-in list every repository gets', () => {
    const builtIn = buildGuardedSet({ guardedPaths: [] });
    for (const path of VERDICT_RULE_FILES) {
      expect(builtIn).not.toContain(path);
    }
  });
});
