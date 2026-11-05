/**
 * Draft builders shared by the RHDS rules.
 * This unit emits Drafts only and never mints a verdict. Every `why` opens with the RHDS source
 * sentence, so a reader sees the design system's own words before usabl's observation. No page
 * text goes into a draft: names, labels, and attribute values decide a rule and stay out of it.
 */
import type { AxNode, Draft, ProviderContext, Severity } from '../../contracts/index.js';
import { quotedSources, RHDS_PACKAGE, RHDS_VERSION, type RhdsRuleId } from './sources.js';

export const RHDS_LAYER = 'rhds';

export interface RhdsDraftParts {
  elementPath: string;
  severity: Severity;
  confidence: Draft['confidence'];
  whatUserExperiences: string;
  // What usabl observed, in one or two sentences. It follows the quoted source in `why`.
  observed: string;
  fix: string;
  // The accessibility node the observation rests on, for the naming rules. Absent for structure.
  node?: AxNode | null;
}

export function rhdsDraft(ctx: ProviderContext, rule: RhdsRuleId, parts: RhdsDraftParts): Draft {
  const node = parts.node ?? null;
  const evidence: Draft['evidence'] = { extra: { source: `${RHDS_PACKAGE}@${RHDS_VERSION}` } };
  if (node !== null) {
    evidence.name = { value: node.name, source: 'ax-tree', fromTree: true };
    evidence.role = { value: node.role, source: 'ax-tree', fromTree: true };
  }

  return {
    rule,
    layer: RHDS_LAYER,
    severity: parts.severity,
    evidenceClass: 'deterministic',
    screenId: ctx.screen.id,
    elementPath: parts.elementPath,
    elementName: null,
    role: node?.role ?? null,
    whatUserExperiences: parts.whatUserExperiences,
    why: `${quotedSources(rule)} ${parts.observed}`,
    fix: parts.fix,
    evidence,
    confidence: parts.confidence,
  };
}

/**
 * The naming rules trust the accessibility tree, and an element that never upgraded has no inner
 * control to read. That is unknown, not a missing name, so it is unverified and never fails.
 */
export function notUpgradedDraft(ctx: ProviderContext, rule: RhdsRuleId, elementPath: string, tag: string): Draft {
  return rhdsDraft(ctx, rule, {
    elementPath,
    severity: 'serious',
    confidence: 'unverified',
    whatUserExperiences: `usabl could not confirm that this ${tag} has an accessible name.`,
    observed: `This ${tag} has no name source in its markup and is not upgraded (its definition did not load), so the accessibility tree has no control to confirm a name on.`,
    fix: `Make sure the ${tag} definition loads on this page, then check again.`,
  });
}

/**
 * The control is there but has no node in the accessibility tree, for example because the
 * component is hidden or closed. An absent node is not an empty name, so this is unverified.
 */
export function nameUnavailableDraft(
  ctx: ProviderContext,
  rule: RhdsRuleId,
  elementPath: string,
  tag: string,
  because: string,
): Draft {
  return rhdsDraft(ctx, rule, {
    elementPath,
    severity: 'serious',
    confidence: 'unverified',
    whatUserExperiences: `usabl could not confirm that this ${tag} has an accessible name.`,
    observed: `This ${tag} has no name source in its markup, and ${because}, so the accessibility tree cannot confirm a name.`,
    fix: `Check the ${tag} while it is shown, or give it a name source in its markup.`,
  });
}

export function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** A CSS attribute value in double quotes, safe for any id or fragment. */
export function cssString(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ').replace(/\r/g, '\\d ').replace(/\f/g, '\\c ')}"`;
}
