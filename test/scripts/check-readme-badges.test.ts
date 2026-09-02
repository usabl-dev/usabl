import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const scriptPath = resolve('scripts/check-readme-badges.mjs');
const repoRoot = resolve('.');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Run the checker over a repo root, capturing the exit code even when it is
// non-zero. A stale badge must exit non-zero, so the reject path is expected.
async function runChecker(root: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, root], {
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

async function writeFixture(version: string, readme: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usabl-badges-'));
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'usabl', version })}\n`, 'utf8');
  await writeFile(join(root, 'README.md'), readme, 'utf8');
  return root;
}

function badgeLine(version: string): string {
  return `![Version](https://img.shields.io/badge/version-${version}-blue?style=flat-square)`;
}

describe('check-readme-badges command', () => {
  let root = '';

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('passes and names the version it verified when the badge matches package.json', async () => {
    root = await writeFixture('1.4.0', `# usabl\n\n${badgeLine('1.4.0')}\n`);

    const result = await runChecker(root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('1.4.0');
  });

  it('fails and names both versions and the file to edit when the badge is stale', async () => {
    root = await writeFixture('1.4.0', `# usabl\n\n${badgeLine('1.3.0')}\n`);

    const result = await runChecker(root);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('1.4.0');
    expect(result.stdout).toContain('1.3.0');
    expect(result.stdout).toContain('README.md');
  });

  it('fails rather than passing silently when the README has no version badge', async () => {
    root = await writeFixture('1.4.0', '# usabl\n\nNo badges here.\n');

    const result = await runChecker(root);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('README.md');
    expect(result.stdout.toLowerCase()).toContain('version badge');
  });

  it('fails when the version badge line carries no readable version', async () => {
    root = await writeFixture(
      '1.4.0',
      '# usabl\n\n![Version](https://img.shields.io/badge/version-blue?style=flat-square)\n',
    );

    const result = await runChecker(root);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('README.md');
  });

  it('fails when more than one version badge could be the source of truth', async () => {
    root = await writeFixture('1.4.0', `# usabl\n\n${badgeLine('1.4.0')}\n${badgeLine('1.4.0')}\n`);

    const result = await runChecker(root);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('README.md');
    expect(result.stdout).toContain('2');
  });

  // The point of the check is this repo, so run it against the real README too.
  // That keeps the badge honest under `npm run test`, not only under fixtures.
  it("passes against this repository's own README", async () => {
    const result = await runChecker(repoRoot);

    expect(result.stdout).toContain('README.md');
    expect(result.code).toBe(0);
  });
});
