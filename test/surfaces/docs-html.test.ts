import { describe, expect, it } from 'vitest';
import type { DocArtifact } from '../../src/contracts/index.js';
import { renderDocsHtml } from '../../src/surfaces/docs-html.js';

// A receipt-bound artifact: the run reached verified, so a receipt exists, the
// artifact carries boundToReceipt and a mint time, and its entries cite evidence.
function boundArtifact(overrides: Partial<DocArtifact> = {}): DocArtifact {
  return {
    kind: 'announcement-snippets',
    surface: 'clusters',
    entries: [
      {
        element: '#root > a:nth-child(1)',
        content: 'Skip to main content, link, focusable',
        status: 'draft',
        evidenceRef: 'stop:tree-abc123:clusters:0',
      },
    ],
    generatedAt: '2026-08-23T00:00:00.000Z',
    boundToReceipt: 'tree-abc123',
    ...overrides,
  };
}

// An unbound artifact: the run did not mint a receipt (a regression, or nothing
// verified), so there is no boundToReceipt, no mint time, and no evidenceRef.
// These are observations of what the page announced, never a proof.
function unboundArtifact(overrides: Partial<DocArtifact> = {}): DocArtifact {
  return {
    kind: 'keyboard-paths',
    surface: 'deployments',
    entries: [
      {
        element: '[1] #deploy-button',
        content: 'name:Deploy | role:button',
        status: 'draft',
      },
    ],
    generatedAt: '',
    ...overrides,
  };
}

// A receipt-bound artifact whose entries carry no per-entry evidence. This is
// exactly what the alt-text manifest generator emits on a verified run: it binds
// to the receipt tree but mints no selector-level pass evidence, so it must never
// read as verified.
function boundWithoutEvidence(overrides: Partial<DocArtifact> = {}): DocArtifact {
  return {
    kind: 'alt-text-manifest',
    surface: 'clusters',
    entries: [{ element: 'img.logo', content: 'Company logo', status: 'approved' }],
    generatedAt: '2026-08-23T00:00:00.000Z',
    boundToReceipt: 'tree-abc123',
    ...overrides,
  };
}

describe('renderDocsHtml', () => {
  it('renders a complete accessible document shell', () => {
    const html = renderDocsHtml([boundArtifact()]);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    // Exactly one top-level heading.
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    // Skip link points at the main landmark, which exists with that id.
    expect(html).toContain('href="#main-content"');
    expect(html).toContain('id="main-content"');
    // The strict house content-security policy, byte for byte.
    expect(html).toContain(
      "content=\"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests\"",
    );
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">');
  });

  it('marks a receipt-bound artifact as verified and cites its receipt', () => {
    const html = renderDocsHtml([boundArtifact()]);

    // The receipt hash and mint time are shown as the proof of coverage.
    expect(html).toContain('tree-abc123');
    expect(html).toContain('2026-08-23T00:00:00.000Z');
    expect(html.toLowerCase()).toContain('bound to receipt');
    // The entry itself is rendered.
    expect(html).toContain('#root &gt; a:nth-child(1)');
    expect(html).toContain('Skip to main content, link, focusable');
    // A bound artifact must not be labelled as an unverified observation.
    expect(html.toLowerCase()).not.toContain('observations, not proof');
  });

  it('marks an unbound artifact as observations only and claims no receipt', () => {
    const html = renderDocsHtml([unboundArtifact()]);

    // The honesty invariant, made textual: observations, never a verdict.
    expect(html.toLowerCase()).toContain('not verified');
    expect(html.toLowerCase()).toContain('observations, not proof');
    // No receipt is fabricated for an unbound artifact.
    expect(html.toLowerCase()).not.toContain('bound to receipt');
    // The distinction carries a non-colour marker, not colour alone.
    expect(html).toContain('⚠');
    // The observation is still rendered so the content is usable.
    expect(html).toContain('name:Deploy | role:button');
  });

  it('never presents a bound artifact without per-entry evidence as verified', () => {
    const html = renderDocsHtml([boundWithoutEvidence()]);

    // The receipt binding is still shown honestly.
    expect(html).toContain('tree-abc123');
    expect(html.toLowerCase()).toContain('bound to receipt');
    // But it is not a verified claim: no positive check glyph appears.
    expect(html).not.toContain('✔');
    // It says, in words, that these entries are not per-element proof.
    expect(html.toLowerCase()).toContain('not per-element proof');
    // And it is not misfiled as an unbound observation either.
    expect(html.toLowerCase()).not.toContain('observations, not proof');
  });

  it('renders an evidence column only when entries actually cite evidence', () => {
    const withEvidence = renderDocsHtml([boundArtifact()]);
    expect(withEvidence).toContain('<th scope="col">Evidence</th>');
    expect(withEvidence).toContain('stop:tree-abc123:clusters:0');

    // An unbound artifact cites no evidence, so no empty, misleading column.
    const withoutEvidence = renderDocsHtml([unboundArtifact()]);
    expect(withoutEvidence).not.toContain('>Evidence<');
  });

  it('renders bound and unbound artifacts independently on one page', () => {
    const html = renderDocsHtml([boundArtifact(), unboundArtifact()]);

    // The verified card and the observation card both appear, each labelled.
    expect(html).toContain('✔');
    expect(html).toContain('⚠');
    expect(html.toLowerCase()).toContain('bound to receipt');
    expect(html.toLowerCase()).toContain('observations, not proof');
    // The overview counts them honestly.
    expect(html).toContain('1 bound to a minted receipt');
    expect(html).toContain('1 shown as observations only');
  });

  it('renders a bound artifact with no entries as a note, not a table', () => {
    const html = renderDocsHtml([boundArtifact({ entries: [] })]);

    expect(html).not.toContain('<table>');
    expect(html.toLowerCase()).toContain('no entries were generated');
  });

  it('escapes every character of page-derived text', () => {
    const nasty = boundArtifact({
      surface: 'x & <y>',
      boundToReceipt: 'tree-abc123',
      entries: [
        {
          element: `a "b" 'c' & <d>`,
          content: `<script>alert(1)</script>`,
          status: 'draft',
          evidenceRef: `stop:tree:<s>:0`,
        },
      ],
    });

    const html = renderDocsHtml([nasty]);

    // No raw markup from page-derived text survives into the document.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<d>');
    // Every one of the five characters is escaped.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
    expect(html).toContain('&lt;s&gt;'); // from the evidenceRef
  });

  it('cannot break out of the datetime attribute via the mint time', () => {
    // generatedAt is the only page-derived value that lands in an attribute
    // (<time datetime="...">), which is a separate injection surface from a text
    // node: a raw double quote would close the attribute and let markup follow.
    const html = renderDocsHtml([
      boundArtifact({ generatedAt: `"><img src=x onerror=alert(1)>` }),
    ]);

    // The quote is neutralised, so the attribute stays closed and no tag escapes.
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('datetime="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });

  it('renders each artifact as a table with a caption and scoped headers', () => {
    const html = renderDocsHtml([boundArtifact()]);

    expect(html).toContain('<caption');
    expect(html).toContain('scope="col"');
  });

  it('renders an honest empty state that makes no verified claim', () => {
    const html = renderDocsHtml([]);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    // Nothing was generated, so nothing is verified.
    expect(html.toLowerCase()).toContain('no accessibility documentation');
    expect(html.toLowerCase()).not.toContain('bound to receipt');
  });

  it('is deterministic for the same input', () => {
    const artifacts = [boundArtifact(), unboundArtifact()];
    expect(renderDocsHtml(artifacts)).toBe(renderDocsHtml(artifacts));
  });
});
