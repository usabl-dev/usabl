import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

// Write the allowlisted pages the staging step requires, with the given content
// per page. Every page not named gets a link-free body so the fixture stages
// cleanly and only the page under test carries links. usabl-walkthrough.html is
// also staged as index.html, so its body is what the site root serves.
async function writePublicPages(source: string, pages: Record<string, string>): Promise<void> {
  await mkdir(source, { recursive: true });
  const defaults: Record<string, string> = {
    'how-usabl-works.html': '<h1 id="intro">How it works</h1>\n',
    'code-walkthrough.html': '<h1 id="top">Code</h1>\n',
    'usabl-walkthrough.html': '<h1 id="top">Walkthrough</h1>\n',
  };
  for (const [name, body] of Object.entries({ ...defaults, ...pages })) {
    await writeFile(join(source, name), body, 'utf8');
  }
}

interface BrokenLink {
  page: string;
  lineNumber: number;
  target: string;
  reason: string;
  missing?: string;
  fragment?: string;
}

interface StagedLinkReport {
  pages: string[];
  broken: BrokenLink[];
  checkedCount: number;
  skippedCount: number;
}

type CheckStagedLinks = (stagedDir: string, stagedFiles: string[]) => Promise<StagedLinkReport>;

// The published allowlist has no nested page today, but the resolver must still
// handle one. These cases call the checker on a hand-built staged set, so they do
// not depend on what the allowlist happens to hold.
async function loadCheckStagedLinks(): Promise<CheckStagedLinks> {
  const module = (await import(pathToFileURL(scriptPath).href)) as {
    checkStagedLinks: CheckStagedLinks;
  };
  return module.checkStagedLinks;
}

async function writeStagedSet(dir: string, files: Record<string, string>): Promise<string[]> {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), body, 'utf8');
  }
  return Object.keys(files).sort();
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
    // The target exists beside the page in the source tree, so the source-tree
    // link check passes, but the staging allowlist never copies it, so the
    // published link returns 404.
    await writePublicPages(source, {
      'how-usabl-works.html':
        '<h1 id="intro">How</h1>\n<p><a href="architecture-map.html">architecture-map.html</a></p>\n',
    });
    await writeFile(join(source, 'architecture-map.html'), '<h1>Map</h1>\n', 'utf8');

    const result = await runChecker(source);

    expect(result.code).toBe(1);
    // The failure names the page, the line, the link as written, and the
    // staged path that is missing, so the fix is obvious from the message.
    expect(result.stdout).toContain('how-usabl-works.html:2');
    expect(result.stdout).toContain('link "architecture-map.html"');
    expect(result.stdout).toContain('points to "architecture-map.html"');
    expect(result.stdout).toContain('not in the staged Pages set');
    expect(result.stdout).toContain('1 broken');
  });

  it('passes when every internal link resolves to a staged file', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-staged-links-good-'));
    const source = join(root, 'docs');
    await writePublicPages(source, {
      'code-walkthrough.html':
        '<h1 id="top">Code</h1>\n' +
        '<a href="how-usabl-works.html#intro">How</a>\n' +
        '<a href="usabl-walkthrough.html?v=2">Walkthrough</a>\n' +
        '<a href="index.html">Index</a>\n' +
        '<a href="#top">Top</a>\n' +
        '<a href="https://example.com/not/fetched">External</a>\n' +
        '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">\n',
    });

    const result = await runChecker(source);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 broken');
    // Three file links and one same-page fragment on the code page. The external
    // URL and the data URI are skipped, not checked.
    expect(result.stdout).toContain('4 internal link(s) checked');
    expect(result.stdout).toContain('2 external link(s) skipped');
  });

  it('validates fragments against the staged file, including the root index', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-staged-links-fragment-'));
    const source = join(root, 'docs');
    // /usabl/ is served as the staged index.html, a copy of usabl-walkthrough.html,
    // which has id="top" and nothing named "missing". The source pass sees /usabl/
    // as the docs directory and cannot check that fragment; this pass must.
    await writePublicPages(source, {
      'how-usabl-works.html':
        '<h1 id="intro">How</h1>\n' +
        '<a href="/usabl/#missing">Root missing</a>\n' +
        '<a href="/usabl/#top">Root present</a>\n' +
        '<a href=".#top">Dot present</a>\n' +
        '<a href="#intro">Same page present</a>\n' +
        '<a href="#nope">Same page missing</a>\n' +
        '<a href="#">Page top</a>\n' +
        '<a href="code-walkthrough.html#gone">Cross page missing</a>\n' +
        '<a href="code-walkthrough.html#top">Cross page present</a>\n',
    });

    const result = await runChecker(source);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      'how-usabl-works.html:2: link "/usabl/#missing" names anchor "#missing", and the staged "index.html" has no element with that id or name',
    );
    expect(result.stdout).toContain(
      'how-usabl-works.html:6: link "#nope" names anchor "#nope", and the staged "how-usabl-works.html" has no element',
    );
    expect(result.stdout).toContain(
      'how-usabl-works.html:8: link "code-walkthrough.html#gone" names anchor "#gone", and the staged "code-walkthrough.html" has no element',
    );
    expect(result.stdout).not.toContain('#top');
    expect(result.stdout).not.toContain('#intro');
    // Seven links checked (the bare # is skipped), three of them broken.
    expect(result.stdout).toContain('7 internal link(s) checked');
    expect(result.stdout).toContain('3 broken');
  });

  it('reads attribute values that span lines and reports the line each URL is on', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-staged-links-multiline-'));
    const source = join(root, 'docs');
    // A line-based scan never sees the closing quote of a wrapped value and
    // silently drops every URL in it.
    await writePublicPages(source, {
      'how-usabl-works.html':
        '<h1 id="intro">How</h1>\n' +
        '<img srcset="gone-one.png 1x,\n' +
        '  gone-two.png 2x" alt="">\n' +
        '<a\n' +
        '  href="gone-three.html">Wrapped</a>\n',
    });

    const result = await runChecker(source);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('how-usabl-works.html:2: link "gone-one.png"');
    expect(result.stdout).toContain('how-usabl-works.html:3: link "gone-two.png"');
    expect(result.stdout).toContain('how-usabl-works.html:5: link "gone-three.html"');
    expect(result.stdout).toContain('3 broken');
  });

  it('fails a root-absolute link because the site is served under a repository path', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-staged-links-root-'));
    const source = join(root, 'docs');
    // code-walkthrough.html is staged, so a naive join would pass this link. In
    // the browser it resolves against the domain root, above the site path, and 404s.
    await writePublicPages(source, {
      'how-usabl-works.html': '<h1 id="intro">How</h1>\n<a href="/code-walkthrough.html">Code</a>\n',
    });

    const result = await runChecker(source);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('how-usabl-works.html:2');
    expect(result.stdout).toContain('link "/code-walkthrough.html" is root-absolute');
    expect(result.stdout).toContain('served under /usabl/');
    expect(result.stdout).toContain('1 broken');
  });

  it('resolves a root-absolute link under the site base path against the staged root', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-staged-links-base-'));
    const source = join(root, 'docs');
    // /usabl/how-usabl-works.html is the published URL of a staged page and
    // returns 200; /usabl/ and /usabl name the site root, served as index.html.
    // /usabl/missing.html is under the base path but names nothing staged.
    await writePublicPages(source, {
      'code-walkthrough.html':
        '<h1 id="top">Code</h1>\n' +
        '<a href="/usabl/how-usabl-works.html">How</a>\n' +
        '<a href="/usabl/">Root</a>\n' +
        '<a href="/usabl">Root no slash</a>\n' +
        '<a href="/usabl/missing.html">Gone</a>\n',
    });

    const result = await runChecker(source);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('4 internal link(s) checked');
    expect(result.stdout).toContain('1 broken');
    expect(result.stdout).toContain('code-walkthrough.html:5');
    expect(result.stdout).toContain('link "/usabl/missing.html" points to "missing.html"');
    expect(result.stdout).not.toContain('how-usabl-works.html"');
    expect(result.stdout).not.toContain('root-absolute');
  });

  it('treats a percent-encoded leading slash as a relative link, as the browser does', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-staged-links-encoded-'));
    const source = join(root, 'docs');
    // %2Fcode-walkthrough.html is relative syntax; the server decodes it and
    // serves the same bytes as code-walkthrough.html. Decoding before classifying
    // once turned it into a root-absolute link and rejected it. The nested form
    // is covered by the staged-set cases below.
    await writePublicPages(source, {
      'how-usabl-works.html':
        '<h1 id="intro">How</h1>\n<a href="%2Fcode-walkthrough.html">Encoded slash</a>\n',
    });

    const result = await runChecker(source);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('1 internal link(s) checked');
    expect(result.stdout).toContain('0 broken');
  });

  it('reports directory references with no staged index.html as missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-staged-links-noindex-'));
    const source = join(root, 'docs');
    // Nothing is staged under guides/, so both directory forms 404. The nested
    // case, a directory that holds a page but no index.html, is covered below.
    await writePublicPages(source, {
      'how-usabl-works.html':
        '<h1 id="intro">How</h1>\n<a href="guides">Bare</a>\n<a href="guides/">Slash</a>\n',
    });

    const result = await runChecker(source);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('how-usabl-works.html:2: link "guides" points to "guides"');
    expect(result.stdout).toContain(
      'how-usabl-works.html:3: link "guides/" points to "guides/index.html"',
    );
    expect(result.stdout).toContain('2 broken');
  });

  it('passes directory references that the site serves as index.html', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-staged-links-index-'));
    const source = join(root, 'docs');
    await writePublicPages(source, {
      'how-usabl-works.html':
        '<h1 id="intro">How</h1>\n<a href=".">Dot</a>\n<a href="./">Dot slash</a>\n',
    });

    const result = await runChecker(source);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('2 internal link(s) checked');
    expect(result.stdout).toContain('0 broken');
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

describe('checkStagedLinks on a staged set with a nested page', () => {
  let root = '';

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
    root = '';
  });

  async function check(files: Record<string, string>): Promise<StagedLinkReport> {
    root = await mkdtemp(join(tmpdir(), 'usabl-staged-links-nested-'));
    const stagedFiles = await writeStagedSet(root, files);
    const checkStagedLinks = await loadCheckStagedLinks();
    return checkStagedLinks(root, stagedFiles);
  }

  const base = {
    'index.html': '<h1 id="top">Walkthrough</h1>\n',
    'how-usabl-works.html': '<h1 id="intro">How it works</h1>\n',
  };

  it('resolves relative and site-rooted links from a nested page', async () => {
    const report = await check({
      ...base,
      'guides/page.html':
        '<h1>Page</h1>\n' +
        '<a href="../how-usabl-works.html#intro">Back</a>\n' +
        '<a href="/usabl/how-usabl-works.html">Site rooted</a>\n' +
        '<a href="/usabl/">Root</a>\n',
    });

    expect(report.broken).toEqual([]);
    expect(report.checkedCount).toBe(3);
  });

  it('resolves a link from a nested page against that page directory', async () => {
    const report = await check({
      ...base,
      'guides/page.html': '<h1>Page</h1>\n<p><a href="map.html">map.html</a></p>\n',
    });

    expect(report.broken).toEqual([
      {
        page: 'guides/page.html',
        lineNumber: 2,
        target: 'map.html',
        reason: 'missing',
        missing: 'guides/map.html',
      },
    ]);
  });

  it('treats a percent-encoded slash inside a path as a relative link', async () => {
    const report = await check({
      ...base,
      'how-usabl-works.html':
        '<h1 id="intro">How</h1>\n<a href="guides%2Fpage.html">Encoded nested slash</a>\n',
      'guides/page.html': '<h1>Page</h1>\n',
    });

    expect(report.broken).toEqual([]);
    expect(report.checkedCount).toBe(1);
  });

  it('reports a directory with no staged index.html, and a climb above the root, as missing', async () => {
    // guides/ holds a page but no index.html, so both directory forms 404.
    // ../.. climbs above the staged root.
    const report = await check({
      ...base,
      'how-usabl-works.html':
        '<h1 id="intro">How</h1>\n<a href="guides">Bare</a>\n<a href="guides/">Slash</a>\n',
      'guides/page.html': '<h1>Page</h1>\n<a href="../..">Above root</a>\n',
    });

    const found = report.broken.map(({ page, lineNumber, target, missing }) => ({
      page,
      lineNumber,
      target,
      missing,
    }));
    expect(found).toEqual([
      { page: 'guides/page.html', lineNumber: 2, target: '../..', missing: '..' },
      { page: 'how-usabl-works.html', lineNumber: 2, target: 'guides', missing: 'guides' },
      {
        page: 'how-usabl-works.html',
        lineNumber: 3,
        target: 'guides/',
        missing: 'guides/index.html',
      },
    ]);
    expect(report.broken.every((entry) => entry.reason === 'missing')).toBe(true);
  });

  it('passes a nested page link up to the root, which the site serves as index.html', async () => {
    const report = await check({
      ...base,
      'guides/page.html': '<h1>Page</h1>\n<a href="..">Up</a>\n<a href="../">Up slash</a>\n',
    });

    expect(report.broken).toEqual([]);
    expect(report.checkedCount).toBe(2);
  });
});
