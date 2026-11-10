import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DocArtifact, Finding, Result } from '../../src/contracts/index.js';
import { formatSummary } from '../../src/output/summary.js';
import { renderDocsHtml } from '../../src/surfaces/docs-html.js';
import { overlayClientSource } from '../../src/surfaces/overlay-client.js';
import { projectPrComment } from '../../src/surfaces/pr-comment.js';

// The product says "accessibility barrier" on every surface a person reads. A bare "barrier" reads
// as jargon, or as a different thing. These tests fail if a bare one comes back in the fixed text
// of the pull request comment, the CLI summary, the overlay, or the docs output.

// A use of the word that is not directly after "accessibility".
const BARE = /(?<!accessibility\s+)\bbarriers?\b/i;

function bareUses(text: string): string[] {
  // A CSS comment inside a style string is never shown to anyone.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => BARE.test(line))
    .map((line) => line.trim());
}

/**
 * The string literals in JavaScript or TypeScript source, comments left out. Template literals
 * count, and the code inside `${}` is read as code. This is enough for the files below, which hold
 * no regular expression literal with a quote or a comment marker in it.
 */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  // A stack of what each open template expects: the depth of braces inside its current `${}`.
  const templates: number[] = [];
  let index = 0;
  let current = '';
  type State = 'code' | 'single' | 'double' | 'template' | 'line' | 'block';
  let state: State = 'code';
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line';
        index += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block';
        index += 2;
        continue;
      }
      // A regular expression literal: a slash where a value starts. Skipped whole, so a quote or a
      // backtick inside one does not open a string.
      if (char === '/' && /[(,=:[!&|?{};]$|^$/.test(source.slice(0, index).trimEnd().slice(-1))) {
        let at = index + 1;
        let inClass = false;
        while (at < source.length && source[at] !== '\n') {
          const c = source[at]!;
          if (c === '\\') {
            at += 2;
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          at += 1;
        }
        index = at + 1;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') {
        state = char === "'" ? 'single' : char === '"' ? 'double' : 'template';
        current = '';
        index += 1;
        continue;
      }
      if (templates.length > 0) {
        if (char === '{') templates[templates.length - 1]! += 1;
        if (char === '}') {
          if (templates[templates.length - 1] === 0) {
            templates.pop();
            state = 'template';
            current = '';
            index += 1;
            continue;
          }
          templates[templates.length - 1]! -= 1;
        }
      }
      index += 1;
      continue;
    }
    if (state === 'line') {
      if (char === '\n') state = 'code';
      index += 1;
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === '\\') {
      current += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (state === 'template' && char === '$' && next === '{') {
      out.push(current);
      templates.push(0);
      state = 'code';
      index += 2;
      continue;
    }
    if ((state === 'single' && char === "'") || (state === 'double' && char === '"') || (state === 'template' && char === '`')) {
      out.push(current);
      state = 'code';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  return out;
}

const SOURCES = [
  'src/surfaces/pr-comment.ts',
  'src/output/summary.ts',
  'src/output/verdict-line.ts',
  'src/output/floor-notice.ts',
  'src/output/debt.ts',
  'src/output/noise-budget.ts',
  'src/output/conformance.ts',
  'src/output/notes.ts',
  'src/surfaces/docs-html.ts',
  'src/surfaces/docs.ts',
  // Engine text that providers and the evidence floor write into the Result, which the comment,
  // the CLI summary, and the overlay print, and the model-facing message pieces.
  'src/providers/row-scope.ts',
  'src/providers/redirected.ts',
  'src/providers/core-stack.ts',
  'src/evidence/floor.ts',
  'src/output/bounded-text.ts',
  'src/output/disclosure.ts',
  'src/surfaces/model-pieces.ts',
  ...readdirSync('src/docs')
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => `src/docs/${name}`),
];

const finding = (over: Partial<Finding>): Finding => ({
  rule: 'color-contrast',
  layer: 'axe',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'clusters',
  elementPath: 'button#submit',
  elementName: 'Submit',
  role: 'button',
  whatUserExperiences: 'Low contrast text',
  why: 'Contrast ratio is too low',
  fix: 'Raise contrast to 4.5:1',
  evidence: {},
  confidence: 'fail',
  elementKey: 'k-submit',
  identityBasis: 'name',
  status: 'new',
  ...over,
});

// Every section the two text surfaces print, with page text and a summary that hold no such word,
// so anything found is the surface's own text.
const everySection = (over: Partial<Result> = {}): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'regression',
  summary: 'regression: 1 blocking finding(s)',
  screens: [
    {
      screenId: 'clusters',
      url: 'http://127.0.0.1:5173/clusters',
      stops: [{ index: 0, elementPath: '#save', announcement: [{ kind: 'name', text: 'Save', fromTree: true, source: 'ax-tree' }] }],
      drafts: [],
      gaps: [],
      applicability: [],
      reachedSelectorPresent: null,
      notes: [{ ref: 'clusters', reason: 'a frame was not read' }],
    },
  ],
  coverage: {
    changedFiles: ['src/a.tsx'],
    affected: [],
    unresolvedFiles: ['src/b.tsx'],
    gaps: [{ ref: 'src/b.tsx', state: 'unresolved', reason: 'no route reaches it' }],
    nothingToCheck: false,
  },
  findings: [
    finding({}),
    finding({ rule: 'label', status: 'carried', elementKey: 'k2' }),
    finding({ rule: 'image-alt', status: 'waived', elementKey: 'k3' }),
    finding({ rule: 'preview-rule', evidenceClass: 'preview', elementKey: 'k4' }),
  ],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 1,
  accessibilityVerdict: 'regression',
  accessibilityExitCode: 1,
  paidDownCount: 2,
  floorHeadroom: [{ screenId: 'clusters', rule: 'label', recorded: 3, observed: 1 }],
  floorUnconfirmed: [{ screenId: 'orders', rules: ['button-name'], barriers: 2 }],
  debt: {
    tracking: 'off',
    off: { cause: 'no-history', detail: null },
    historyHead: null,
    floorBarriers: 4,
    acceptedBarriers: 4,
    confirmedFixed: 0,
    fixedThisRun: 2,
    remaining: 2,
    oldestOpenDays: 3,
    intermittent: 1,
  },
  ...over,
});

const verdicts: Array<Partial<Result>> = [
  {},
  { verdict: 'verified', exitCode: 0, accessibilityVerdict: 'verified', accessibilityExitCode: 0, findings: [finding({ status: 'carried' })] },
  { verdict: 'not_covered', exitCode: 3, accessibilityVerdict: 'not_covered', accessibilityExitCode: 3 },
  { verdict: 'approval_required', exitCode: 2, dirtyGuardedPaths: ['usabl.config.json'] },
  { verdict: null, exitCode: 0, accessibilityVerdict: null, accessibilityExitCode: 0, findings: [], coverage: { changedFiles: ['README.md'], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true } },
  { verdict: null, exitCode: 4, accessibilityVerdict: null, accessibilityExitCode: 4, summary: 'unhandled error: boom' },
];

describe('surface text says "accessibility barrier"', () => {
  for (const path of SOURCES) {
    it(`has no bare "barrier" in the strings of ${path}`, () => {
      const literals = stringLiterals(readFileSync(path, 'utf8'));

      expect(literals.flatMap(bareUses)).toEqual([]);
    });
  }

  it('has no bare "barrier" in the strings of the overlay client', () => {
    // The overlay client is shipped as one source string. Its own comments are left out.
    expect(stringLiterals(overlayClientSource).flatMap(bareUses)).toEqual([]);
  });

  for (const over of verdicts) {
    const name = String(over.verdict === undefined ? 'regression' : over.verdict) + ` (exit ${over.exitCode ?? 1})`;

    it(`prints no bare "barrier" in the pull request comment for ${name}`, () => {
      expect(bareUses(projectPrComment(everySection(over)))).toEqual([]);
    });

    it(`prints no bare "barrier" in the CLI summary for ${name}`, () => {
      expect(bareUses(formatSummary(everySection(over)))).toEqual([]);
    });
  }

  it('prints no bare "barrier" on the docs page', () => {
    const artifact = (over: Partial<DocArtifact>): DocArtifact => ({
      kind: 'keyboard-paths',
      surface: 'clusters',
      entries: [{ element: '#save', content: 'Save, button', status: 'draft' }],
      generatedAt: '',
      ...over,
    });
    const html = renderDocsHtml([
      artifact({}),
      artifact({ boundToReceipt: 'tree', generatedAt: '2026-01-01T00:00:00.000Z', entries: [{ element: '#a', content: 'A', status: 'draft', evidenceRef: 'stop:tree:clusters:0' }] }),
      artifact({ boundToReceipt: 'tree', kind: 'alt-text-manifest' }),
      artifact({ kind: 'alt-text-manifest', entries: [{ element: 'img', content: 'Logo', status: 'draft', origin: 'page' }] }),
      artifact({ stale: true, staleReason: 'This report was made from tree a, and the code is now at tree b.' }),
    ]);

    expect(bareUses(html)).toEqual([]);
    expect(bareUses(renderDocsHtml([]))).toEqual([]);
  });

  it('catches a bare use, so the check itself works', () => {
    expect(bareUses('### New barriers')).toEqual(['### New barriers']);
    expect(bareUses('### New accessibility barriers')).toEqual([]);
    expect(stringLiterals("const a = 'one barrier'; // a barrier in a comment\nconst b = `x ${'y'} barriers`;")).toEqual([
      'one barrier',
      'x ',
      'y',
      ' barriers',
    ]);
  });
});
