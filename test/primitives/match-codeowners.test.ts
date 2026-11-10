import { describe, expect, it } from 'vitest';
import { compileCodeownersPattern, type CodeownersMatch } from '../../src/primitives/match-codeowners.js';

function stateOf(pattern: string, path: string): CodeownersMatch {
  const compiled = compileCodeownersPattern(pattern);
  if (!compiled.ok) {
    throw new Error(`${pattern} was refused: ${compiled.reason}`);
  }
  return compiled.state(path);
}

function matches(pattern: string, path: string): boolean {
  return stateOf(pattern, path) === 'match';
}

/**
 * Every example in GitHub's CODEOWNERS documentation that usabl supports, with the paths the
 * documentation names or describes. The documentation's `**\/logs` example is refused below,
 * because usabl does not read `**`.
 */
const GITHUB_DOCUMENTED: Array<[pattern: string, path: string, expected: CodeownersMatch]> = [
  // "*  @global-owner1 @global-owner2": the default owners for everything in the repo.
  ['*', 'README.md', 'match'],
  ['*', 'src/gate/index.ts', 'match'],
  ['*', '.github/CODEOWNERS', 'match'],
  // "*.js  @js-owner": a pull request that only modifies JS files.
  ['*.js', 'app.js', 'match'],
  ['*.js', 'src/lib/app.js', 'match'],
  ['*.js', 'app.ts', 'none'],
  // "*.go docs@example.com" and "*.txt @octo-org/octocats": all files of that type.
  ['*.go', 'cmd/main.go', 'match'],
  ['*.txt', 'notes/a.txt', 'match'],
  // "/build/logs/ @doctocat": the build/logs directory at the root and any of its subdirectories.
  ['/build/logs/', 'build/logs/a.log', 'match'],
  ['/build/logs/', 'build/logs/sub/b.log', 'match'],
  ['/build/logs/', 'src/build/logs/a.log', 'none'],
  // "docs/*": files like docs/getting-started.md, but not docs/build-app/troubleshooting.md.
  ['docs/*', 'docs/getting-started.md', 'match'],
  ['docs/*', 'docs/build-app/troubleshooting.md', 'none'],
  // "apps/ @octocat": any file in an apps directory anywhere in the repository.
  ['apps/', 'apps/a.js', 'match'],
  ['apps/', 'src/apps/a.js', 'match'],
  ['apps/', 'deeply/nested/apps/x/y.js', 'match'],
  // "/docs/ @doctocat": the /docs directory at the root and any of its subdirectories.
  ['/docs/', 'docs/a.md', 'match'],
  ['/docs/', 'docs/sub/b.md', 'match'],
  ['/docs/', 'src/docs/a.md', 'none'],
  // "/scripts/ @doctocat @octocat": any change inside the /scripts directory.
  ['/scripts/', 'scripts/deploy.sh', 'match'],
  // "/apps/ @octocat" with "/apps/github" (no owner, or @doctocat): the subdirectory has its own rule.
  ['/apps/', 'apps/github/x.js', 'match'],
  ['/apps/github', 'apps/github/x.js', 'match'],
  ['/apps/github', 'apps/other.js', 'none'],
  // "CODEOWNERS paths are case sensitive."
  ['/docs/', 'Docs/a.md', 'none'],
];

/**
 * Forms GitHub's documentation does not settle. Where every reading usabl knows of agrees, the
 * answer stands. Where they differ, the answer is unknown, and the policy check refuses the path
 * when such a rule could be its last match.
 */
const NOT_DOCUMENTED: Array<[pattern: string, path: string, expected: CodeownersMatch]> = [
  // A pattern with an inner slash and no leading slash: gitignore anchors it at the root, and the
  // documentation shows only root paths for docs/*.
  ['docs/*', 'src/docs/a.md', 'unknown'],
  ['src/gate/', 'src/gate/a.ts', 'match'],
  ['src/gate/', 'vendor/src/gate/a.ts', 'unknown'],
  // A slash-free name with no trailing slash: the file of that name at any depth is certain, a
  // folder of that name is not documented.
  ['.usabl-evidence.json', 'state/.usabl-evidence.json', 'match'],
  ['gate', 'src/gate/index.ts', 'unknown'],
  // A ? wildcard is not in the documentation.
  ['/src/rule?.ts', 'src/rule1.ts', 'unknown'],
  ['/src/rule?.ts', 'src/ruleab.ts', 'none'],
  // A wildcard in the last segment never matches through a parent folder, as with docs/*.
  ['*.js', 'lib.js/x.ts', 'none'],
  ['/src/*', 'src/gate/index.ts', 'none'],
];

describe('compileCodeownersPattern', () => {
  it('matches every documented GitHub example the way GitHub documents it', () => {
    for (const [pattern, path, expected] of GITHUB_DOCUMENTED) {
      expect(stateOf(pattern, path), `${pattern} against ${path}`).toBe(expected);
    }
  });

  it('reads a form the documentation does not settle as unknown where readings differ', () => {
    for (const [pattern, path, expected] of NOT_DOCUMENTED) {
      expect(stateOf(pattern, path), `${pattern} against ${path}`).toBe(expected);
    }
  });

  it('matches a leading-slash directory against git paths beneath it', () => {
    expect(matches('/src/gate/', 'src/gate/index.ts')).toBe(true);
    expect(matches('/src/gate/', 'src/gate/nested/deep.ts')).toBe(true);
  });

  it('matches a leading-slash file against that exact git path', () => {
    expect(matches('/src/run.ts', 'src/run.ts')).toBe(true);
    expect(matches('/usabl.config.json', 'usabl.config.json')).toBe(true);
  });

  it('anchors a leading slash at the repository root', () => {
    expect(matches('/src/gate/', 'vendor/src/gate/index.ts')).toBe(false);
    expect(matches('/src/run.ts', 'vendor/src/run.ts')).toBe(false);
  });

  it('does not let a directory pattern spill into a sibling with the same prefix', () => {
    expect(matches('/src/gate/', 'src/gateway/index.ts')).toBe(false);
  });

  it('owns everything under a path even without a trailing slash', () => {
    expect(matches('/src/gate', 'src/gate/index.ts')).toBe(true);
  });

  it('treats a slash-free pattern as any-depth, the way gitignore does', () => {
    expect(matches('.usabl-evidence.json', '.usabl-evidence.json')).toBe(true);
    expect(matches('.usabl-evidence.json', 'state/.usabl-evidence.json')).toBe(true);
    expect(matches('*', 'src/gate/index.ts')).toBe(true);
  });

  it('keeps a single star inside one path segment', () => {
    expect(matches('/src/*.ts', 'src/run.ts')).toBe(true);
    expect(matches('/src/*.ts', 'src/gate/index.ts')).toBe(false);
  });

  it('refuses patterns it cannot interpret rather than matching nothing', () => {
    for (const pattern of ['src/**/*.ts', '**/logs', '!src/gate/', 'src/[ab].ts', 'src/a\\ b.ts', '/', 'src//gate', '/src/*/index.ts']) {
      const compiled = compileCodeownersPattern(pattern);
      expect(compiled.ok, pattern).toBe(false);
    }
  });
});
