import { describe, it, expect } from 'vitest';
import { formatSummary } from '../../src/output/summary.js';
import { projectPrComment } from '../../src/surfaces/pr-comment.js';
import type { DocsSourceMapping, Finding, Result } from '../../src/contracts/index.js';

// The renderers must surface a docs finding's source mapping: the file and construct the author
// edits, plus the syntax-aware fix. App findings (no docsSource) must render exactly as before.

function finding(over: Partial<Finding>): Finding {
  return {
    rule: 'image-alt',
    layer: 'docs-axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'clusters',
    elementPath: 'img',
    elementName: null,
    role: null,
    whatUserExperiences: 'Image has no text alternative.',
    why: 'A screen reader announces nothing for this image.',
    fix: 'generic finding fix',
    evidence: { extra: { html: '<img src="create-cluster.png">' } },
    confidence: 'fail',
    elementKey: 'clusters:img',
    identityBasis: 'structural',
    status: 'new',
    ...over,
  };
}

function contentMapping(over: Partial<DocsSourceMapping> = {}): DocsSourceMapping {
  return {
    tier: 'content',
    file: 'modules/proc_create.adoc',
    candidates: ['modules/proc_create.adoc'],
    construct: 'image::create-cluster.png',
    line: null,
    fix: 'Add alt text between the brackets in AsciiDoc, for example: image::create-cluster.png[Create cluster dialog].',
    ...over,
  };
}

function resultWith(findings: Finding[]): Result {
  return {
    schemaVersion: 'usabl.result.v1',
    verdict: 'regression',
    summary: 'one new barrier',
    screens: [],
    coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
    findings,
    receipt: null,
    dirtyGuardedPaths: [],
    exitCode: 1,
    accessibilityVerdict: 'regression',
    accessibilityExitCode: 1,
    paidDownCount: 0,
    floorHeadroom: [],
  };
}

describe('formatSummary source mapping', () => {
  it('prints the source file, construct, and the syntax-aware fix for a docs finding', () => {
    const out = formatSummary(resultWith([finding({ docsSource: contentMapping() })]));
    expect(out).toContain('source: modules/proc_create.adoc -> image::create-cluster.png');
    expect(out).toContain('fix: Add alt text between the brackets in AsciiDoc');
    // The generic finding fix is superseded by the AsciiDoc-phrased fix.
    expect(out).not.toContain('generic finding fix');
  });

  it('prints an exact file:line when the renderer tier supplied a line', () => {
    const out = formatSummary(
      resultWith([
        finding({
          docsSource: contentMapping({ tier: 'renderer', construct: null, line: 42, fix: 'x' }),
        }),
      ]),
    );
    expect(out).toContain('source: modules/proc_create.adoc:42');
  });

  it('discloses every candidate when ownership is ambiguous', () => {
    const out = formatSummary(
      resultWith([
        finding({
          docsSource: contentMapping({
            candidates: ['modules/a.adoc', 'modules/b.adoc'],
            file: 'modules/a.adoc',
          }),
        }),
      ]),
    );
    expect(out).toContain('candidates: modules/a.adoc, modules/b.adoc');
  });

  it('prints no source line for an app finding with no source mapping', () => {
    // An app finding never carries docsSource. Omitting the key (rather than setting it to
    // undefined) is the honest app-finding shape and satisfies exactOptionalPropertyTypes.
    const out = formatSummary(
      resultWith([finding({ layer: 'axe', screenId: 'home' })]),
    );
    expect(out).not.toContain('source:');
    // App findings keep their own fix text.
    expect(out).toContain('fix: generic finding fix');
  });
});

describe('projectPrComment source mapping', () => {
  it('renders a source line and the syntax-aware fix for a docs finding', () => {
    // Source now sits inside the finding's untrusted frame (an app source can be read from a
    // renderer-injected DOM attribute), so it renders as a plain piece, not a markdown list line.
    const out = projectPrComment(resultWith([finding({ docsSource: contentMapping() })]));
    // Page-derived values are written as code spans at this surface, so a renderer reads no
    // markup in them and the brackets of the AsciiDoc construct reach the reader as brackets.
    expect(out).toContain('source: `modules/proc_create.adoc -> image::create-cluster.png`');
    expect(out).toContain('Add alt text between the brackets in AsciiDoc');
  });

  it('discloses candidates when ownership is ambiguous', () => {
    const out = projectPrComment(
      resultWith([
        finding({
          docsSource: contentMapping({
            candidates: ['modules/a.adoc', 'modules/b.adoc'],
            file: 'modules/a.adoc',
          }),
        }),
      ]),
    );
    expect(out).toContain('candidates: `modules/a.adoc, modules/b.adoc`');
  });

  it('renders no source line for an app finding', () => {
    const out = projectPrComment(
      resultWith([finding({ layer: 'axe', screenId: 'home' })]),
    );
    expect(out).not.toContain('- source:');
  });
});
