import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const scriptPath = resolve('scripts/check-staged-links.mjs');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Run the staged link check over a docs source directory, capturing the exit
// code even when it is non-zero. A dangling link must exit non-zero.
async function runChecker(sourceDir: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, sourceDir], {
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

// Write the four allowlisted pages the staging step requires, with the given
// content per page. Every page not named gets a link-free body so the fixture
// stages cleanly and only the page under test carries links.
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

describe('check-staged-links command', () => {
  let root = '';

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('fails when a staged page links a file that exists in source but is not staged', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-staged-links-bad-'));
    const source = join(root, 'docs');
    // The exact shape of the deck defect: the target exists beside the deck in
    // the source tree, so the source-tree link check passes, but the staging
    // allowlist never copies it, so the published link returns 404.
    await writePublicPages(source, {
      'demo/product-deck.html':
        '<h1>Deck</h1>\n<p><a href="architecture-map.html">architecture-map.html</a></p>\n',
    });
    await writeFile(join(source, 'demo', 'architecture-map.html'), '<h1>Map</h1>\n', 'utf8');

    const result = await runChecker(source);

    expect(result.code).toBe(1);
    // The failure names the page, the line, the link as written, and the
    // staged path that is missing, so the fix is obvious from the message.
    expect(result.stdout).toContain('demo/product-deck.html:2');
    expect(result.stdout).toContain('link "architecture-map.html"');
    expect(result.stdout).toContain('points to "demo/architecture-map.html"');
    expect(result.stdout).toContain('not in the staged Pages set');
    expect(result.stdout).toContain('1 broken');
  });

  it('passes when every internal link resolves to a staged file', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-staged-links-good-'));
    const source = join(root, 'docs');
    await writePublicPages(source, {
      'team-orientation.html':
        '<h1 id="top">Orientation</h1>\n' +
        '<a href="how-usabl-works.html#intro">How</a>\n' +
        '<a href="code-walkthrough.html?v=2">Walkthrough</a>\n' +
        '<a href="demo/product-deck.html">Deck</a>\n' +
        '<a href="#top">Top</a>\n' +
        '<a href="https://example.com/not/fetched">External</a>\n' +
        '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">\n',
      'demo/product-deck.html': '<h1>Deck</h1>\n<a href="../team-orientation.html">Back</a>\n',
    });

    const result = await runChecker(source);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 broken');
    // Three file links on the orientation page count twice because it is also
    // staged as index.html, plus the one link on the deck. The same-page
    // fragment, the external URL, and the data URI are skipped, not checked.
    expect(result.stdout).toContain('7 internal link(s) checked');
    expect(result.stdout).toContain('6 external or same-page link(s) skipped');
  });

  it('reports a link that escapes the staged tree as missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-staged-links-escape-'));
    const source = join(root, 'docs');
    // README.md exists one level above docs in the real repository, and the
    // source-tree check would resolve it. It is never staged, so it must fail here.
    await writePublicPages(source, {
      'how-usabl-works.html': '<h1 id="intro">How</h1>\n<a href="../README.md">Readme</a>\n',
    });
    await writeFile(join(root, 'README.md'), '# Readme\n', 'utf8');

    const result = await runChecker(source);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('how-usabl-works.html:2');
    expect(result.stdout).toContain('points to "../README.md"');
  });
});
