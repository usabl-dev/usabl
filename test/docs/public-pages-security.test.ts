import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const pages = ['docs/team-orientation.html', 'docs/how-usabl-works.html', 'docs/code-walkthrough.html'];

describe('public Pages security', () => {
  for (const page of pages) {
    it(`${page} contains restrictive browser metadata and no active content`, async () => {
      const html = await readFile(page, 'utf8');
      expect(html).toContain('http-equiv="Content-Security-Policy"');
      expect(html).toContain("default-src 'none'");
      expect(html).toContain("script-src 'none'");
      expect(html).toContain("form-action 'none'");
      expect(html).toContain('name="referrer" content="no-referrer"');
      expect(html).toContain('name="robots" content="noindex, nofollow, noarchive"');
      expect(html).not.toMatch(/<(script|iframe|form|object|embed)\b/i);
      expect(html).not.toContain('href="guides/');
    });
  }

  it('core README points to the published team pages', async () => {
    const readme = await readFile('README.md', 'utf8');
    expect(readme).toContain('https://usabl-dev.github.io/usabl/team-orientation.html');
    expect(readme).toContain('https://usabl-dev.github.io/usabl/how-usabl-works.html');
  });
});
