import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const scriptPath = resolve('scripts/check-docs-a11y.mjs');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Run the scanner over a docs root, capturing the exit code even when non-zero.
// A confirmed WCAG violation must exit non-zero, so the reject path is expected.
async function runScanner(root: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, root], { encoding: 'utf8' });
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

async function writeDoc(root: string, name: string, html: string): Promise<void> {
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', name), html, 'utf8');
}

// A page shell whose only accessibility defect is the body it is given, so an
// assertion on color-contrast is not confused by unrelated findings.
function shell(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title></head><body><main>${body}</main></body></html>`;
}

describe('check-docs-a11y command', { timeout: 60_000 }, () => {
  let root = '';

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('fails on a confirmed color-contrast violation and names the doc', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-a11y-bad-'));
    // #aaaaaa on #ffffff is about 2.3:1, below the 4.5:1 AA threshold.
    await writeDoc(root, 'page.html', shell('<p style="color:#aaaaaa;background:#ffffff">Faint text.</p>'));

    const result = await runScanner(root);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('docs/page.html');
    expect(result.stdout).toContain('color-contrast');
  });

  it('passes when contrast meets AA', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-a11y-good-'));
    await writeDoc(root, 'page.html', shell('<p style="color:#111111;background:#ffffff">Readable text.</p>'));

    const result = await runScanner(root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 WCAG A/AA violation(s)');
  });

  it('catches a violation on a hidden slide it has to reveal to see', async () => {
    // This is the trap that produced a false "clean" before: a naive single
    // scan only sees the visible view. The defect sits on a `hidden` slide, so
    // the scanner must drive the deck's own hash navigation to reveal and check
    // every view. The fixture carries a minimal version of that navigation.
    root = await mkdtemp(join(tmpdir(), 'usabl-a11y-slides-'));
    const nav = [
      '<script>',
      'function show(){',
      '  var id = location.hash.slice(1);',
      "  document.querySelectorAll('.slide').forEach(function(s){ s.hidden = id ? s.id !== id : false; });",
      '}',
      "window.addEventListener('hashchange', show); show();",
      '</script>',
    ].join('\n');
    const html =
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Deck</title></head><body>' +
      '<section class="slide" id="one"><h1>Visible and fine</h1><p style="color:#111;background:#fff">Readable.</p></section>' +
      '<section class="slide" id="two" hidden><h1>Hidden</h1>' +
      '<p style="color:#aaaaaa;background:#ffffff">Faint text on a hidden slide.</p></section>' +
      nav +
      '</body></html>';
    await writeDoc(root, 'deck.html', html);

    const result = await runScanner(root);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('[two]');
    expect(result.stdout).toContain('color-contrast');
  });
});
