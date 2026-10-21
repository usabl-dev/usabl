import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// The static published pages carry no active content at all, so their policy can
// refuse script outright.
const staticPages = ['docs/how-usabl-works.html', 'docs/code-walkthrough.html'];

// The walkthrough is the one published page with behaviour: the audience tabs and
// the outcome simulator. It is held to the same policy shape, with script allowed
// only by the hash of the exact block in the file.
const walkthroughPage = 'docs/usabl-walkthrough.html';

function expectRestrictiveMetadata(html: string): void {
  expect(html).toContain('http-equiv="Content-Security-Policy"');
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("form-action 'none'");
  expect(html).toContain("base-uri 'none'");
  expect(html).toContain("object-src 'none'");
  expect(html).toContain("frame-src 'none'");
  expect(html).toContain('name="referrer" content="no-referrer"');
  expect(html).toContain('name="robots" content="noindex, nofollow, noarchive"');
  expect(html).not.toMatch(/<(iframe|form|object|embed)\b/i);
  expect(html).not.toContain('href="guides/');
}

describe('public Pages security', () => {
  for (const page of staticPages) {
    it(`${page} contains restrictive browser metadata and no active content`, async () => {
      const html = await readFile(page, 'utf8');
      expectRestrictiveMetadata(html);
      expect(html).toContain("script-src 'none'");
      expect(html).not.toMatch(/<script\b/i);
    });
  }

  it(`${walkthroughPage} contains restrictive browser metadata`, async () => {
    const html = await readFile(walkthroughPage, 'utf8');
    expectRestrictiveMetadata(html);
    expect(html).toContain("connect-src 'none'");
    // The only hosts the page may reach are the two that serve its fonts.
    expect(html).toContain("style-src 'unsafe-inline' https://fonts.googleapis.com");
    expect(html).toContain('font-src https://fonts.gstatic.com');
  });

  it(`${walkthroughPage} pins its one inline script by hash`, async () => {
    const html = await readFile(walkthroughPage, 'utf8');
    const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
    // One block, with no src and no attributes: a remote script would not be covered
    // by a hash, and a second block would need a second hash nobody would remember to add.
    expect(blocks).toHaveLength(1);
    const [whole, body] = blocks[0] as unknown as [string, string];
    expect(whole).toMatch(/^<script>/);

    // The hash in the policy must be the hash of what is actually in the file. Without
    // this the script silently stops running the moment somebody edits it.
    const digest = createHash('sha256').update(body, 'utf8').digest('base64');
    expect(html).toContain(`script-src 'sha256-${digest}'`);
  });

  it('core README points to the published walkthrough and the contributor files', async () => {
    const readme = await readFile('README.md', 'utf8');
    // The walkthrough is the first document the README hands out.
    expect(readme).toContain('https://usabl-dev.github.io/usabl/');
    // An open-source README must lead a visitor to the contributor and security policies.
    for (const file of ['CONTRIBUTING.md', 'AGENTS.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md']) {
      expect(readme).toContain(`](${file})`);
    }
    // Pages that were removed from the project must not come back as entry points.
    for (const removed of ['team-orientation.html', 'product-deck.html', 'docs/demo/']) {
      expect(readme).not.toContain(removed);
    }
  });
});
