import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const packageJsonPath = resolve('package.json');

// The docs:linkcheck npm script runs the source-tree pass and then the staged
// pass. A link can pass one and fail the other, so a test that invokes only one
// script cannot prove the real CI command accepts or rejects a link. These
// tests read the command from package.json, assert its shape, and run the same
// scripts in the same order against a fixture.
interface PassResult {
  code: number;
  stdout: string;
}

async function runScript(script: string, arg: string): Promise<PassResult> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [resolve(script), arg], {
      encoding: 'utf8',
    });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '' };
  }
}

// Parse the composite command into its ordered script paths.
async function linkcheckScripts(): Promise<string[]> {
  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    scripts: Record<string, string>;
  };
  const command = pkg.scripts['docs:linkcheck'] ?? '';
  return command.split('&&').map((part) => {
    const words = part.trim().split(/\s+/);
    expect(words[0]).toBe('node');
    return words[1] ?? '';
  });
}

// Run the passes the way the npm script does: in order, stopping at the first
// failure. The source pass takes the repository root; the staged pass takes the
// docs directory under it, matching each script's default when run from the root.
async function runComposite(root: string): Promise<PassResult & { passesRun: number }> {
  const scripts = await linkcheckScripts();
  const args: Record<string, string> = {
    'scripts/check-doc-links.mjs': root,
    'scripts/check-staged-links.mjs': join(root, 'docs'),
  };
  let stdout = '';
  let passesRun = 0;
  for (const script of scripts) {
    const arg = args[script];
    expect(arg, `unexpected script in docs:linkcheck: ${script}`).toBeDefined();
    passesRun += 1;
    const result = await runScript(script, arg ?? root);
    stdout += result.stdout;
    if (result.code !== 0) return { code: result.code, stdout, passesRun };
  }
  return { code: 0, stdout, passesRun };
}

async function writePublicPages(source: string, pages: Record<string, string>): Promise<void> {
  await mkdir(join(source, 'demo'), { recursive: true });
  const defaults: Record<string, string> = {
    'team-orientation.html': '<h1 id="top">Orientation</h1>\n',
    'how-usabl-works.html': '<h1 id="intro">How it works</h1>\n',
    'code-walkthrough.html': '<h1>Walkthrough</h1>\n',
    'demo/product-deck.html': '<h1>Deck</h1>\n',
  };
  for (const [name, body] of Object.entries({ ...defaults, ...pages })) {
    await writeFile(join(source, name), body, 'utf8');
  }
}

describe('docs:linkcheck composite command', () => {
  let root = '';

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('runs the source-tree pass and then the staged pass', async () => {
    await expect(linkcheckScripts()).resolves.toEqual([
      'scripts/check-doc-links.mjs',
      'scripts/check-staged-links.mjs',
    ]);
  });

  it('accepts a query string on an internal link in both passes', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-composite-query-'));
    // The source pass once treated `page.html?v=2` as a file named with the
    // query and reported it missing, while the staged pass stripped the query
    // and accepted it. The composite command failed on a valid link.
    await writePublicPages(join(root, 'docs'), {
      'team-orientation.html':
        '<h1 id="top">Orientation</h1>\n<a href="how-usabl-works.html?v=2#intro">How</a>\n',
    });

    const result = await runComposite(root);

    expect(result.code).toBe(0);
    expect(result.passesRun).toBe(2);
    expect(result.stdout).toContain('0 broken');
  });

  it('rejects a link the source tree resolves but the staged set does not', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-composite-staged-'));
    const source = join(root, 'docs');
    await writePublicPages(source, {
      'demo/product-deck.html':
        '<h1>Deck</h1>\n<p><a href="architecture-map.html">architecture-map.html</a></p>\n',
    });
    await writeFile(join(source, 'demo', 'architecture-map.html'), '<h1>Map</h1>\n', 'utf8');

    const result = await runComposite(root);

    expect(result.code).toBe(1);
    // The source pass passed (the file exists) and the staged pass caught it.
    expect(result.passesRun).toBe(2);
    expect(result.stdout).toContain('demo/product-deck.html:2');
    expect(result.stdout).toContain('not in the staged Pages set');
  });

  it('rejects a root-absolute link in the source pass before staging runs', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-composite-root-'));
    await writePublicPages(join(root, 'docs'), {
      'team-orientation.html': '<h1 id="top">Orientation</h1>\n<a href="/how-usabl-works.html">How</a>\n',
    });

    const result = await runComposite(root);

    expect(result.code).toBe(1);
    expect(result.passesRun).toBe(1);
    expect(result.stdout).toContain('/how-usabl-works.html');
  });
});
