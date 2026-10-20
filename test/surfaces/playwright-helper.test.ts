import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CoverageGap, Draft, Requirement, RequirementBundle, Result } from '../../src/contracts/index.js';
import {
  assertUsablVerdict,
  loadProjectIntake,
  requirementGapsForPage,
  summarizePageCheck,
} from '../../src/surfaces/playwright-helper.js';

const draft = (over: Partial<Draft>): Draft => ({
  rule: 'color-contrast',
  layer: 'axe',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'page',
  elementPath: 'button',
  elementName: null,
  role: null,
  whatUserExperiences: 'text is hard to read',
  why: 'contrast below 4.5:1',
  fix: 'raise contrast',
  evidence: {},
  confidence: 'fail',
  ...over,
});

const gap = (over: Partial<CoverageGap> = {}): CoverageGap => ({
  ref: 'provider:pf-rulepack',
  state: 'not-covered',
  reason: 'provider pf-rulepack failed: boom',
  ...over,
});

const baseResult = (over: Partial<Result>): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: 0 gating finding(s)',
  screens: [],
  coverage: {
    changedFiles: [],
    affected: [],
    unresolvedFiles: [],
    gaps: [],
    nothingToCheck: false,
  },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  ...over,
});

describe('assertUsablVerdict', () => {
  it('passes when verdict is in the allowed list', () => {
    const outcome = assertUsablVerdict(baseResult({ verdict: 'verified', exitCode: 0 }), ['verified']);

    expect(outcome.passed).toBe(true);
    expect(outcome.verdict).toBe('verified');
    expect(outcome.exitCode).toBe(0);
  });

  it('fails when verdict is not allowed', () => {
    const outcome = assertUsablVerdict(
      baseResult({ verdict: 'regression', summary: 'regression: 1 new deterministic finding(s)', exitCode: 1 }),
      ['verified'],
    );

    expect(outcome.passed).toBe(false);
    expect(outcome.verdict).toBe('regression');
    expect(outcome.exitCode).toBe(1);
  });

  it('allows not_covered when callers opt into that verdict', () => {
    const outcome = assertUsablVerdict(
      baseResult({ verdict: 'not_covered', summary: 'not_covered: unresolved surfaces', exitCode: 3 }),
      ['verified', 'not_covered'],
    );

    expect(outcome.passed).toBe(true);
    expect(outcome.verdict).toBe('not_covered');
  });

  it('returns a scrubbed safeResult for egress', () => {
    const outcome = assertUsablVerdict(
      baseResult({
        verdict: 'regression',
        exitCode: 1,
        findings: [
          {
            rule: 'color-contrast',
            layer: 'axe',
            severity: 'serious',
            evidenceClass: 'deterministic',
            screenId: 'clusters',
            elementPath: 'button',
            elementName: 'Save',
            role: 'button',
            whatUserExperiences: 'token=SECRETPOISON in page text',
            why: 'token=SECRETPOISON in explanation',
            fix: 'raise contrast',
            evidence: {},
            confidence: 'fail',
            elementKey: 'k',
            identityBasis: 'name',
            status: 'new',
          },
        ],
      }),
      ['verified'],
    );

    expect(JSON.stringify(outcome.safeResult)).not.toContain('SECRETPOISON');
  });
});

describe('summarizePageCheck', () => {
  it('reports verified when there are no drafts and no gaps', () => {
    const result = summarizePageCheck([], []);

    expect(result.verdict).toBe('verified');
    expect(result.failures).toEqual([]);
    expect(result.needsReview).toEqual([]);
    expect(result.gaps).toEqual([]);
    expect(result.drafts).toEqual([]);
  });

  it('reports regression when any draft has fail confidence', () => {
    const failure = draft({ rule: 'image-alt', confidence: 'fail' });

    const result = summarizePageCheck([failure], []);

    expect(result.verdict).toBe('regression');
    expect(result.failures).toEqual([failure]);
    expect(result.needsReview).toEqual([]);
  });

  it('reports not_covered when only unverified drafts are present', () => {
    const incomplete = draft({ rule: 'color-contrast', confidence: 'unverified' });

    const result = summarizePageCheck([incomplete], []);

    expect(result.verdict).toBe('not_covered');
    expect(result.failures).toEqual([]);
    expect(result.needsReview).toEqual([incomplete]);
  });

  it('reports not_covered when a provider gap exists even with clean drafts', () => {
    const result = summarizePageCheck([], [gap()]);

    expect(result.verdict).toBe('not_covered');
    expect(result.gaps).toHaveLength(1);
  });

  it('lets a fail confidence draft outrank unverified drafts and gaps', () => {
    const failure = draft({ rule: 'button-name', confidence: 'fail' });
    const incomplete = draft({ rule: 'color-contrast', confidence: 'unverified' });

    const result = summarizePageCheck([failure, incomplete], [gap()]);

    expect(result.verdict).toBe('regression');
    expect(result.failures).toEqual([failure]);
    expect(result.needsReview).toEqual([incomplete]);
    expect(result.gaps).toHaveLength(1);
  });

  it('summarizes the counts that set the verdict', () => {
    const result = summarizePageCheck(
      [draft({ confidence: 'fail' }), draft({ confidence: 'unverified' })],
      [gap()],
    );

    expect(result.summary).toContain('regression');
    expect(result.summary).toContain('1 blocking');
    expect(result.summary).toContain('1 needs review');
    expect(result.summary).toContain('1 gap');
  });
});

describe('requirementGapsForPage', () => {
  const content = (id: string, surface: string): Requirement => ({
    id,
    kind: 'content',
    surface,
    description: id,
    assertion: { type: 'content', selector: 'h1', expectedText: 'Clusters' },
    approved: true,
  });
  const bundle = (...requirements: Requirement[]): RequirementBundle => ({ version: 1, requirements });
  const known = new Set(['clusters', 'reports']);

  it('reports no gap for a requirement on this page, which its provider checks', () => {
    expect(requirementGapsForPage(bundle(content('heading', 'clusters')), 'clusters', known)).toEqual([]);
  });

  it('reports no gap for a requirement on another known surface when this page is a known surface', () => {
    expect(requirementGapsForPage(bundle(content('heading', 'clusters')), 'reports', known)).toEqual([]);
  });

  it('reports every runtime requirement as a gap when the page is not labeled with a surface', () => {
    const gaps = requirementGapsForPage(
      bundle(content('heading', 'clusters'), content('title', 'reports')),
      'page',
      known,
    );
    expect(gaps.map((gap) => gap.ref)).toEqual(['requirement:heading', 'requirement:title']);
    expect(gaps.every((gap) => gap.state === 'not-covered')).toBe(true);
    expect(gaps[0]?.reason).toContain('screenId');
  });

  it('reports a requirement whose surface matches no configured or discovered surface', () => {
    const gaps = requirementGapsForPage(bundle(content('heading', 'clustrs')), 'clusters', known);
    expect(gaps).toEqual([
      {
        ref: 'requirement:heading',
        state: 'not-covered',
        reason:
          'requirement heading names surface clustrs, which matches no configured or discovered surface, so it was not checked',
      },
    ]);
  });

  it('treats a page labeled with a requirement surface as known even when config does not list it', () => {
    // The page is the requirement's surface, so the requirement runs here and nothing is a guess.
    expect(requirementGapsForPage(bundle(content('heading', 'settings')), 'settings', known)).toEqual([]);
  });

  it('never reports a doc requirement, which is not a runtime check', () => {
    const doc: Requirement = {
      id: 'manifest',
      kind: 'doc',
      surface: 'nowhere',
      description: 'manifest',
      assertion: { type: 'doc', artifact: 'alt-text-manifest' },
      approved: true,
    };
    expect(requirementGapsForPage(bundle(doc), 'page', known)).toEqual([]);
  });

  it('reports every runtime requirement as a gap for an unlabeled page, even when a surface is named page', () => {
    // An unlabeled call is not any surface. If it read as the surface "page", the requirement
    // for clusters would fall out of scope with no gap, and nothing would have checked it.
    const withPageSurface = new Set(['page', 'clusters']);
    const gaps = requirementGapsForPage(
      bundle(content('heading', 'clusters'), content('page-title', 'page')),
      null,
      withPageSurface,
    );
    expect(gaps.map((gap) => gap.ref)).toEqual(['requirement:heading', 'requirement:page-title']);
    expect(gaps[0]?.reason).toContain('not labeled');
  });
});

describe('loadProjectIntake', () => {
  async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'usabl-intake-'));
    try {
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('is a gap that names the root when the caller passed a projectRoot that has no usabl.config.json', async () => {
    await withDir(async (dir) => {
      const intake = await loadProjectIntake(dir, true);
      expect(intake.project).toEqual({ root: dir, configFound: false });
      expect(intake.gaps).toHaveLength(1);
      expect(intake.gaps[0]).toMatchObject({ ref: 'usabl.config.json', state: 'not-covered' });
      expect(intake.gaps[0]?.reason).toContain(dir);
    });
  });

  it('stays silent when the default root has no usabl.config.json, and says which root it read', async () => {
    await withDir(async (dir) => {
      const intake = await loadProjectIntake(dir, false);
      expect(intake.gaps).toEqual([]);
      expect(intake.requirements).toEqual({ version: 1, requirements: [] });
      expect(intake.project).toEqual({ root: dir, configFound: false });
    });
  });

  it('does not search parent directories for a config', async () => {
    await withDir(async (dir) => {
      const config = {
        appBaseUrl: 'http://127.0.0.1:5173',
        uiFileGlobs: ['src/**'],
        discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
        surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['src/Clusters.tsx'] }],
        guardedPaths: [],
      };
      await writeFile(join(dir, 'usabl.config.json'), JSON.stringify(config));
      const child = await mkdtemp(join(dir, 'child-'));
      const intake = await loadProjectIntake(child, true);
      expect(intake.project).toEqual({ root: child, configFound: false });
      expect(intake.gaps.map((gap) => gap.ref)).toEqual(['usabl.config.json']);

      const parent = await loadProjectIntake(dir, true);
      expect(parent.project).toEqual({ root: dir, configFound: true });
      expect(parent.gaps).toEqual([]);
    });
  });
});
