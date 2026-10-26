import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const scriptPath = resolve('scripts/check-doc-links.mjs');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Run the checker over a corpus root, capturing the exit code even when it is
// non-zero. A broken link must exit non-zero, so the reject path is expected.
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

describe('check-doc-links command', () => {
  let root = '';
  let outer = '';

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
    if (outer !== '') await rm(outer, { recursive: true, force: true });
    root = '';
    outer = '';
  });

  it('reports a broken relative link with its source and exits non-zero', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-bad-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'a.md'), '# A\n\nSee [gone](./missing.md).\n', 'utf8');

    const result = await runChecker(root);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('docs/a.md');
    expect(result.stdout).toContain('missing.md');
  });

  it('flags a broken intra-page anchor', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-anchor-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(
      join(root, 'docs', 'a.md'),
      '# A\n\n## Real section\n\nJump to [nowhere](#missing-section).\n',
      'utf8',
    );

    const result = await runChecker(root);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('#missing-section');
  });

  it('passes when every relative link and anchor resolves', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-good-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(
      join(root, 'docs', 'a.md'),
      '# A\n\n## Deep dive\n\nSee [b](./b.md) and jump to [here](#deep-dive).\n',
      'utf8',
    );
    await writeFile(join(root, 'docs', 'b.md'), '# B\n\nBack to [a](./a.md).\n', 'utf8');

    const result = await runChecker(root);

    expect(result.code).toBe(0);
  });

  it('accepts a query string on a relative link', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-query-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(
      join(root, 'docs', 'a.html'),
      '<h1 id="top">A</h1>\n<a href="b.html?v=2">b</a>\n<a href="b.html?v=2#intro">b intro</a>\n',
      'utf8',
    );
    await writeFile(join(root, 'docs', 'b.html'), '<h1 id="intro">B</h1>\n', 'utf8');

    const result = await runChecker(root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('2 relative link(s) checked');
  });

  it('resolves root-absolute links under the site base path against docs and rejects the rest', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-base-'));
    await mkdir(join(root, 'docs', 'nested'), { recursive: true });
    await writeFile(
      join(root, 'docs', 'nested', 'a.html'),
      '<h1 id="top">A</h1>\n' +
        '<a href="/usabl/b.html#intro">Under base</a>\n' +
        '<a href="/usabl/">Site root</a>\n' +
        '<a href="/b.html">Outside base</a>\n' +
        '<a href="%2Fb.html">Encoded slash, relative</a>\n',
      'utf8',
    );
    await writeFile(join(root, 'docs', 'b.html'), '<h1 id="intro">B</h1>\n', 'utf8');
    await writeFile(join(root, 'docs', 'nested', 'b.html'), '<h1>Nested B</h1>\n', 'utf8');

    const result = await runChecker(root);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('4 relative link(s) checked');
    expect(result.stdout).toContain('1 broken');
    expect(result.stdout).toContain(
      'docs/nested/a.html:4: root-absolute path outside the site base path /usabl/: /b.html',
    );
    // The encoded slash is relative syntax and names nested/b.html, not /b.html.
    expect(result.stdout).not.toContain('%2Fb.html');
  });

  it('keeps a data URL srcset candidate whole and still checks the next candidate', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-srcset-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(
      join(root, 'docs', 'a.html'),
      '<img srcset="data:image/png;base64,PAYLOADPART,MOREPAYLOAD 1x, here.png 2x" alt="">\n' +
        '<img srcset="here.png, gone.png 2x" alt="">\n',
      'utf8',
    );
    await writeFile(join(root, 'docs', 'here.png'), 'x', 'utf8');

    const result = await runChecker(root);

    expect(result.code).not.toBe(0);
    // The data URL is one external candidate, never split at its commas, so no
    // part of its payload reaches the output.
    expect(result.stdout).not.toContain('PAYLOAD');
    expect(result.stdout).toContain('1 external URL(s) skipped');
    expect(result.stdout).toContain('3 relative link(s) checked');
    expect(result.stdout).toContain('docs/a.html:2: file not found: gone.png');
    expect(result.stdout).toContain('1 broken');
  });

  it('reads attribute values that span lines and reports the line each URL is on', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-multiline-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(
      join(root, 'docs', 'a.html'),
      '<h1>A</h1>\n' +
        '<img srcset="gone-one.png 1x,\n' +
        '  gone-two.png 2x" alt="">\n' +
        '<a\n' +
        '  href="gone-three.html">Wrapped</a>\n' +
        '<a href="here.html">Same line</a>\n',
      'utf8',
    );
    await writeFile(join(root, 'docs', 'here.html'), '<h1>Here</h1>\n', 'utf8');

    const result = await runChecker(root);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('docs/a.html:2: file not found: gone-one.png');
    expect(result.stdout).toContain('docs/a.html:3: file not found: gone-two.png');
    expect(result.stdout).toContain('docs/a.html:5: file not found: gone-three.html');
    expect(result.stdout).toContain('4 relative link(s) checked');
    expect(result.stdout).toContain('3 broken');
  });

  it('extracts the string form of a CSS @import inside a style block', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-import-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(
      join(root, 'docs', 'a.html'),
      '<style>\n@import "gone-theme.css";\n@import url("here.css");\n</style>\n',
      'utf8',
    );
    await writeFile(join(root, 'docs', 'here.css'), 'x', 'utf8');

    const result = await runChecker(root);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('docs/a.html:2: file not found: gone-theme.css');
    expect(result.stdout).toContain('2 relative link(s) checked');
    expect(result.stdout).toContain('1 broken');
  });

  // The extractor covers srcset candidates, the video poster, the object data
  // attribute, url() inside a style block, and url() inside an inline style.
  const richPage = (prefix: string): string =>
    [
      '<style>',
      `  .hero { background: url(${prefix}hero.png); }`,
      `  .logo { background-image: url("${prefix}logo.svg"); }`,
      '</style>',
      '<h1 id="top">A</h1>',
      `<img src="${prefix}small.png" srcset="${prefix}small.png 1x, ${prefix}large.png 2x" alt="">`,
      `<video poster="${prefix}poster.jpg" src="${prefix}clip.mp4"></video>`,
      `<object data="${prefix}doc.pdf" type="application/pdf"></object>`,
      `<div style="background: url('${prefix}inline.png')"></div>`,
      '<svg><path marker-end="url(#arrow)"></path><marker id="arrow"></marker></svg>',
      '<p data-title="not-a-link.html">text</p>',
      '',
    ].join('\n');
  const richAssets = [
    'hero.png',
    'logo.svg',
    'small.png',
    'large.png',
    'poster.jpg',
    'clip.mp4',
    'doc.pdf',
    'inline.png',
  ];

  it('passes srcset, poster, object data, and CSS url() links that resolve', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-rich-good-'));
    await mkdir(join(root, 'docs', 'assets'), { recursive: true });
    await writeFile(join(root, 'docs', 'a.html'), richPage('assets/'), 'utf8');
    for (const asset of richAssets) {
      await writeFile(join(root, 'docs', 'assets', asset), 'x', 'utf8');
    }

    const result = await runChecker(root);

    expect(result.code).toBe(0);
    // Nine references: eight assets, with small.png counted once from src and
    // once from srcset. The data-title attribute is not a link, and the SVG
    // marker-end attribute is not a style context, so neither is counted.
    expect(result.stdout).toContain('9 relative link(s) checked');
    expect(result.stdout).toContain('0 broken');
  });

  it('reports each srcset, poster, object data, and CSS url() link that is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-rich-bad-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'a.html'), richPage('gone/'), 'utf8');

    const result = await runChecker(root);

    expect(result.code).not.toBe(0);
    for (const asset of richAssets) {
      expect(result.stdout).toContain(`file not found: gone/${asset}`);
    }
    expect(result.stdout).not.toContain('not-a-link.html');
    // Each occurrence is reported, so small.png counts from both src and srcset.
    expect(result.stdout).toContain('9 broken');
  });

  it('does not check external http(s) links over the network', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-ext-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(
      join(root, 'docs', 'a.md'),
      '# A\n\n[external](https://example.com/this/path/does/not/exist).\n',
      'utf8',
    );

    const result = await runChecker(root);

    expect(result.code).toBe(0);
  });

  it('discloses a link that resolves but escapes the repo root without failing', async () => {
    // Lay the corpus root inside an outer directory and put the target as a
    // sibling of the root, so the link resolves on disk yet points outside the
    // repo and would break in a clean clone.
    outer = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-escape-'));
    root = join(outer, 'repo');
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(outer, 'outside.md'), '# Outside\n', 'utf8');
    await writeFile(
      join(root, 'docs', 'a.md'),
      '# A\n\nSee [outside](../../outside.md).\n',
      'utf8',
    );

    const result = await runChecker(root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('escape the repo root');
    expect(result.stdout).toContain('docs/a.md');
    expect(result.stdout).toContain('../../outside.md');
    expect(result.stdout).toContain('0 broken');
  });
});

// Reference-style links and autolinks were not extracted at all, so a broken one passed as if it
// were not a link. Each form below must be read, resolved, and reported when it is broken.
describe('check-doc-links reference-style links', () => {
  let root = '';

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
    root = '';
  });

  async function corpus(files: Record<string, string>): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-ref-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(root, 'docs', name), content, 'utf8');
    }
    return root;
  }

  it('reports a full reference whose definition names a missing file, on the line of the link', async () => {
    const result = await runChecker(
      await corpus({ 'a.md': '# A\n\nSee [the guide][guide].\n\n[guide]: ./missing.md\n' }),
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('docs/a.md:3: file not found: ./missing.md');
  });

  it('reports a collapsed and a shortcut reference whose definitions name missing files', async () => {
    const result = await runChecker(
      await corpus({
        'a.md': [
          '# A',
          '',
          'See [collapsed][] and [shortcut].',
          '',
          '[collapsed]: ./gone-collapsed.md',
          '[shortcut]: ./gone-shortcut.md "A title"',
          '',
        ].join('\n'),
      }),
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('docs/a.md:3: file not found: ./gone-collapsed.md');
    expect(result.stdout).toContain('docs/a.md:3: file not found: ./gone-shortcut.md');
  });

  it('reports a full or collapsed reference to a label that is never defined', async () => {
    const result = await runChecker(
      await corpus({ 'a.md': '# A\n\nSee [the guide][nowhere] and [absent][].\n' }),
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('docs/a.md:3: undefined link reference: [nowhere]');
    expect(result.stdout).toContain('docs/a.md:3: undefined link reference: [absent]');
  });

  it('checks a reference image and a fragment in a definition', async () => {
    const result = await runChecker(
      await corpus({
        'a.md': '# A\n\n![diagram][pic] and [section][sec].\n\n[pic]: ./missing.png\n[sec]: ./b.md#no-such-heading\n',
        'b.md': '# B\n\n## Real heading\n',
      }),
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('docs/a.md:3: file not found: ./missing.png');
    expect(result.stdout).toContain('docs/a.md:3: missing anchor: ./b.md#no-such-heading');
  });

  it('passes when every reference resolves, matching labels without regard to case or spacing', async () => {
    const result = await runChecker(
      await corpus({
        'a.md': [
          '# A',
          '',
          'See [B][The  Other Page], [the other page][], [THE OTHER PAGE], and [angle][].',
          '',
          '[the other page]: ./b.md#real-heading',
          '  [angle]: <./b.md>',
          '',
        ].join('\n'),
        'b.md': '# B\n\n## Real heading\n',
      }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('4 relative link(s) checked');
    expect(result.stdout).toContain('0 broken');
  });

  it('leaves bracketed text that is not a reference alone', async () => {
    // A shortcut with no definition renders as plain text, as do a task list box and a
    // bracketed label, so none of them is a link. Text inside code spans and fenced code is an
    // example, not a link.
    const result = await runChecker(
      await corpus({
        'a.md': [
          '# A',
          '',
          '- [ ] a task',
          '- [x] a done task',
          '[BEGIN UNTRUSTED TEXT] marks the start of page text.',
          'Write `[text][ref]` with `[ref]: ./x.md` to make one.',
          '',
          '```',
          '[guide][nowhere]',
          '[nowhere]: ./missing.md',
          '```',
          '',
        ].join('\n'),
      }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 relative link(s) checked');
  });

  it('counts a reference to an external URL as skipped, not checked', async () => {
    const result = await runChecker(
      await corpus({ 'a.md': '# A\n\nSee [the site][site].\n\n[site]: https://example.test/missing\n' }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('1 external URL(s) skipped');
  });
});

describe('check-doc-links autolinks', () => {
  let root = '';

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
    root = '';
  });

  async function corpus(files: Record<string, string>): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'usabl-linkcheck-auto-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(root, 'docs', name), content, 'utf8');
    }
    return root;
  }

  it('reports an autolink to a missing file and a missing anchor', async () => {
    const result = await runChecker(
      await corpus({
        'a.md': '# A\n\n## Here\n',
        'b.md': '# B\n\nSee <./also-missing.md>.\n\nAnd <../docs/a.md#gone> and </usabl/missing.html>.\n',
      }),
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('docs/b.md:3: file not found: ./also-missing.md');
    expect(result.stdout).toContain('docs/b.md:5: missing anchor: ../docs/a.md#gone');
    expect(result.stdout).toContain('docs/b.md:5: file not found: /usabl/missing.html');
  });

  it('passes an autolink that resolves', async () => {
    const result = await runChecker(
      await corpus({ 'a.md': '# A\n\n## Here\n\nJump <#here>, or read <./b.md>.\n', 'b.md': '# B\n' }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('2 relative link(s) checked');
  });

  it('counts an absolute autolink as external and does not fetch it', async () => {
    const result = await runChecker(
      await corpus({ 'a.md': '# A\n\nSee <https://example.test/this/does/not/exist> or <mailto:team@example.test>.\n' }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 relative link(s) checked, 2 external URL(s) skipped');
  });

  it('does not read an HTML tag or a code span as an autolink', async () => {
    const result = await runChecker(
      await corpus({
        'a.md': '# A\n\nLine<br/>break, <span>text</span>, </p>, and `<./not-a-link.md>`.\n',
      }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 relative link(s) checked');
  });
});
