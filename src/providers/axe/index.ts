/**
 * axe-core baseline provider that projects raw axe issue nodes into Drafts.
 * It must never mint a verdict, and it must never drop incomplete findings.
 * Incomplete nodes stay unverified so the gate can disclose not-covered honestly.
 * It also records which rules axe reached a conclusion about. That record is evidence about
 * coverage, not a judgment: nothing here decides whether an outcome is expected.
 */
import type {
  CoverageGap,
  Draft,
  EvidenceClass,
  Provider,
  ProviderContext,
  ProviderOutput,
  RuleApplicability,
  RuleOutcome,
  Severity,
} from '../../contracts/index.js';
import {
  GRADIENT_CONTRAST_CHECK,
  GRADIENT_CONTRAST_EXPERIENCE,
  GRADIENT_CONTRAST_WHY,
  isGradientContrastReview,
} from '../../primitives/gradient-contrast.js';
import { ROW_TARGET_KEY } from '../row-scope.js';
import { noteFor } from './notes.js';

export interface AxeCheck {
  data?: unknown;
}

export interface AxeNode {
  target: string[];
  // The target one part per boundary, present only for an element inside a frame or a shadow
  // root. See ElementTarget.
  targetParts?: string[][];
  html?: string;
  failureSummary?: string;
  any?: AxeCheck[];
}

export interface AxeIssue {
  id: string;
  impact?: 'critical' | 'serious' | 'moderate' | 'minor' | null;
  description: string;
  nodes: AxeNode[];
}

/**
 * A rule axe reached a conclusion about without producing a finding. Deliberately not an AxeIssue:
 * a passing rule can carry hundreds of nodes per rule per screen and none of them are needed to
 * record that the rule ran. The count is what applicability is about.
 *
 * No description. It is static per rule id, so carrying one per rule per screen would be the same
 * bulk the node list was, and a field the record does not contain must never be able to drop an
 * entry from the record.
 */
export interface AxeRuleSummary {
  id: string;
  nodeCount: number;
}

/** A frame axe could not check: its origin, never its full address, and why. */
export interface AxeUncheckedFrame {
  origin: string;
  why: string;
}

export interface AxeRunResult {
  violations: AxeIssue[];
  incomplete: AxeIssue[];
  passes: AxeRuleSummary[];
  inapplicable: AxeRuleSummary[];
  // Frames axe could not load into or run in. Their findings are not in the buckets above, so each
  // one is disclosed as a gap. Absent means every frame was checked.
  uncheckedFrames?: AxeUncheckedFrame[];
}

export interface AxePage {
  runAxe(options?: { tags?: readonly string[] }): Promise<AxeRunResult>;
}

// The Red Hat WCAG 2.2 AA bar for the docs surface. WCAG conformance is cumulative, so 2.2 AA
// carries every Level A and AA criterion from 2.0, 2.1, and 2.2. axe-core 4.13.0 has no wcag22a
// tag, so wcag21a is the only Level A tag beyond wcag2a. The app path passes no tags so axe keeps
// its default ruleset and the app evidence floor never shifts.
export const DOCS_AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

// Turns runAxe options into a tag-scoped builder. Generic over the builder so unit tests can pass a
// fake without dragging playwright or @axe-core into an ordinary test run.
export function applyAxeTags<B extends { withTags(t: string[]): B }>(
  builder: B,
  options?: { tags?: readonly string[] },
): B {
  // No tags means keep axe's default ruleset, so the app path is unchanged. An empty tag
  // array is treated as no tags on purpose: withTags([]) would filter to zero rules and
  // report a false clean.
  return options?.tags && options.tags.length > 0 ? builder.withTags([...options.tags]) : builder;
}

function isAxePage(page: ProviderContext['page']): page is ProviderContext['page'] & AxePage {
  return 'runAxe' in page && typeof page.runAxe === 'function';
}

function mapSeverity(impact: AxeIssue['impact']): Severity {
  switch (impact) {
    case 'critical':
    case 'serious':
    case 'moderate':
    case 'minor':
      return impact;
    default:
      return 'moderate';
  }
}

/**
 * Which layer an axe-shaped result belongs to. The open-source axe provider and a commercial
 * engine that returns axe-shaped results share one mapping, so a draft means the same thing
 * whichever of them produced it.
 *
 * rulePrefix exists because finding identity leaves the layer out on purpose, so axe and
 * PatternFly reports of one defect collapse to one identity. Another engine's rule ids must
 * therefore differ from axe's in the id itself, or its findings would merge into axe's floor
 * entries and waivers. The prefix goes on the draft and applicability rule only; notes are still
 * looked up by the engine's own id.
 *
 * evidenceClass is what the producing engine may claim. The axe provider claims deterministic. An
 * engine whose repeatability is not proven claims preview, which the gate shows and never gates on.
 */
export interface AxeMappingOptions {
  layer: string;
  rulePrefix?: string;
  evidenceClass?: EvidenceClass;
}

const AXE_LAYER = 'axe';
const AXE_MAPPING: AxeMappingOptions = { layer: AXE_LAYER };

function ruleIdFor(issueId: string, options: AxeMappingOptions): string {
  return `${options.rulePrefix ?? ''}${issueId}`;
}

function mapNodeToDraft(
  issue: AxeIssue,
  node: AxeNode,
  confidence: Draft['confidence'],
  screenId: string,
  options: AxeMappingOptions,
): Draft {
  const note = noteFor(issue.id);
  const fallback = node.failureSummary ?? '';
  const firstAny = node.any?.[0];

  const extra: Record<string, unknown> = {};
  if (node.html !== undefined) {
    extra.html = node.html;
  }
  if (firstAny?.data !== undefined) {
    extra.axeData = firstAny.data;
  }
  // The joined element path names nothing, or the wrong element, past a frame or a shadow root.
  // The row read uses these parts instead. See ROW_TARGET_KEY.
  if (node.targetParts !== undefined) {
    extra[ROW_TARGET_KEY] = node.targetParts;
  }

  const evidence = Object.keys(extra).length === 0 ? {} : { extra };
  const whatUserExperiences =
    confidence === 'unverified' ? `Needs review: ${issue.description}` : issue.description;

  const draft: Draft = {
    rule: ruleIdFor(issue.id, options),
    layer: options.layer,
    severity: mapSeverity(issue.impact),
    evidenceClass: options.evidenceClass ?? 'deterministic',
    screenId,
    elementPath: node.target.join(' '),
    elementName: null,
    role: null,
    whatUserExperiences,
    why: note.why || fallback,
    fix: note.fix || fallback,
    evidence,
    confidence,
  };
  // A gradient background is the one needs-review reason with its own words, because the generic
  // contrast text tells a person to fix a ratio nobody measured. Only the prose changes. The rule,
  // element, severity, evidence, and confidence stay as they are, so identity and the verdict do too.
  return isGradientContrastReview(draft)
    ? { ...draft, whatUserExperiences: GRADIENT_CONTRAST_EXPERIENCE, why: GRADIENT_CONTRAST_WHY, fix: GRADIENT_CONTRAST_CHECK }
    : draft;
}

function mapIssueToDrafts(
  issue: AxeIssue,
  confidence: Draft['confidence'],
  screenId: string,
  options: AxeMappingOptions,
): Draft[] {
  return issue.nodes.map((node) => mapNodeToDraft(issue, node, confidence, screenId, options));
}

// A frame axe could not check is a gap on the screen, never a silent drop: the screen's result
// would otherwise read as if the frame had nothing wrong with it.
function uncheckedFrameGap(frame: AxeUncheckedFrame): CoverageGap {
  return {
    ref: 'provider:axe-core',
    state: 'not-covered',
    reason: `provider axe-core could not check a frame from ${frame.origin}: ${frame.why}. Its findings are not in this result.`,
  };
}

function issueApplicability(
  issue: AxeIssue,
  outcome: RuleOutcome,
  screenId: string,
  options: AxeMappingOptions,
): RuleApplicability {
  return {
    screenId,
    layer: options.layer,
    rule: ruleIdFor(issue.id, options),
    outcome,
    elementCount: issue.nodes.length,
  };
}

function summaryApplicability(
  summary: AxeRuleSummary,
  outcome: RuleOutcome,
  screenId: string,
  options: AxeMappingOptions,
): RuleApplicability {
  return {
    screenId,
    layer: options.layer,
    rule: ruleIdFor(summary.id, options),
    outcome,
    elementCount: summary.nodeCount,
  };
}

/**
 * Projects one axe-shaped run into drafts and applicability. Pure: the same result and options
 * always give the same output, and nothing here decides whether an outcome is expected.
 */
export function mapAxeRunResult(
  axeResult: Pick<AxeRunResult, 'violations' | 'incomplete' | 'passes' | 'inapplicable'>,
  screenId: string,
  options: AxeMappingOptions = AXE_MAPPING,
): { drafts: Draft[]; applicability: RuleApplicability[] } {
  const drafts: Draft[] = [];
  // One entry per rule axe reached a conclusion about, in axe's own four buckets. This records
  // what ran; it never decides whether an outcome is expected, and it never becomes a finding.
  const applicability: RuleApplicability[] = [];

  for (const issue of axeResult.violations) {
    drafts.push(...mapIssueToDrafts(issue, 'fail', screenId, options));
    applicability.push(issueApplicability(issue, 'failed', screenId, options));
  }

  // Incomplete stays visible as unverified. Dropping it would silently claim clean coverage.
  for (const issue of axeResult.incomplete) {
    drafts.push(...mapIssueToDrafts(issue, 'unverified', screenId, options));
    applicability.push(issueApplicability(issue, 'incomplete', screenId, options));
  }

  for (const summary of axeResult.passes) {
    applicability.push(summaryApplicability(summary, 'passed', screenId, options));
  }

  for (const summary of axeResult.inapplicable) {
    applicability.push(summaryApplicability(summary, 'inapplicable', screenId, options));
  }

  return { drafts, applicability };
}

export const axeProvider: Provider = {
  id: 'axe-core',
  layer: AXE_LAYER,
  capabilities: ['live'],
  // axe runs on every screen it is given, app and docs alike. Which of its rules apply is reported
  // per rule after the scan.
  appliesBeforeScan: () => ({ applies: true }),
  async run(ctx: ProviderContext): Promise<ProviderOutput> {
    if (!isAxePage(ctx.page)) {
      throw new Error('axe provider requires page.runAxe()');
    }

    // Docs runs the WCAG 2.2 AA tag set. App passes no argument so its call stays byte-identical.
    const axeResult =
      (ctx.profile ?? 'app') === 'docs'
        ? await ctx.page.runAxe({ tags: DOCS_AXE_TAGS })
        : await ctx.page.runAxe();
    const { drafts, applicability } = mapAxeRunResult(axeResult, ctx.screen.id);
    const gaps = (axeResult.uncheckedFrames ?? []).map((frame) => uncheckedFrameGap(frame));
    return { drafts, applicability, gaps };
  },
};
