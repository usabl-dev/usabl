/**
 * axe-core baseline provider that projects raw axe issue nodes into Drafts.
 * It must never mint a verdict, and it must never drop incomplete findings.
 * Incomplete nodes stay unverified so the gate can disclose not-covered honestly.
 */
import type { Draft, Provider, ProviderContext, Severity } from '../../contracts/index.js';
import { noteFor } from './notes.js';

export interface AxeCheck {
  data?: unknown;
}

export interface AxeNode {
  target: string[];
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

export interface AxePage {
  runAxe(options?: { tags?: readonly string[] }): Promise<{ violations: AxeIssue[]; incomplete: AxeIssue[] }>;
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

function mapNodeToDraft(
  issue: AxeIssue,
  node: AxeNode,
  confidence: Draft['confidence'],
  ctx: ProviderContext,
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

  const evidence = Object.keys(extra).length === 0 ? {} : { extra };
  const whatUserExperiences =
    confidence === 'unverified' ? `Needs review: ${issue.description}` : issue.description;

  return {
    rule: issue.id,
    layer: 'axe',
    severity: mapSeverity(issue.impact),
    evidenceClass: 'deterministic',
    screenId: ctx.screen.id,
    elementPath: node.target.join(' '),
    elementName: null,
    role: null,
    whatUserExperiences,
    why: note.why || fallback,
    fix: note.fix || fallback,
    evidence,
    confidence,
  };
}

function mapIssueToDrafts(
  issue: AxeIssue,
  confidence: Draft['confidence'],
  ctx: ProviderContext,
): Draft[] {
  return issue.nodes.map((node) => mapNodeToDraft(issue, node, confidence, ctx));
}

export const axeProvider: Provider = {
  id: 'axe-core',
  layer: 'axe',
  capabilities: ['live'],
  async run(ctx: ProviderContext): Promise<Draft[]> {
    if (!isAxePage(ctx.page)) {
      throw new Error('axe provider requires page.runAxe()');
    }

    // Docs runs the WCAG 2.2 AA tag set. App passes no argument so its call stays byte-identical.
    const axeResult =
      (ctx.profile ?? 'app') === 'docs'
        ? await ctx.page.runAxe({ tags: DOCS_AXE_TAGS })
        : await ctx.page.runAxe();
    const drafts: Draft[] = [];

    for (const issue of axeResult.violations) {
      drafts.push(...mapIssueToDrafts(issue, 'fail', ctx));
    }

    // Incomplete stays visible as unverified. Dropping it would silently claim clean coverage.
    for (const issue of axeResult.incomplete) {
      drafts.push(...mapIssueToDrafts(issue, 'unverified', ctx));
    }

    return drafts;
  },
};
