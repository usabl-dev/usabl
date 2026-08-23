/**
 * Word-level voicing advisory checks for interaction contract windows.
 * This unit emits preview Draft observations by default and deterministic misses
 * only when the caller passes a promoted obligation class list.
 * It must never mint a verdict, write a receipt, or write promotion config.
 * Gate remains the only verdict authority.
 */
import type { AnnouncementToken, Draft, InteractionContract, SpeechObligation, TranscriptStop } from '../contracts/index.js';
import { obligationSatisfied } from './normalize.js';

function nonEmptyText(text: string | null): text is string {
  return text !== null && text.trim().length > 0;
}

function firstNonEmptyToken(tokens: AnnouncementToken[], kind: AnnouncementToken['kind']): AnnouncementToken | null {
  const hit = tokens.find((token) => token.kind === kind && nonEmptyText(token.text));
  return hit ?? null;
}

function observedTextQuote(stop?: TranscriptStop): string {
  if (stop === undefined) {
    return 'none';
  }

  // Keep operator-facing evidence as raw transcript text. Normalization belongs to
  // comparator matching only, and showing normalized tokens would hide what AT said.
  const observed = stop.announcement
    .map((token) => token.text)
    .filter(nonEmptyText)
    .map((text) => `"${text.trim()}"`);

  return observed.length > 0 ? observed.join(', ') : 'none';
}

function makeMissingAnnouncementDraft(
  obligation: SpeechObligation,
  screenId: string,
  elementPath: string,
  promoted: boolean,
  stop?: TranscriptStop,
): Draft {
  const roleToken = stop ? firstNonEmptyToken(stop.announcement, 'role') : null;
  const nameToken = stop ? firstNonEmptyToken(stop.announcement, 'name') : null;
  const observed = observedTextQuote(stop);
  return {
    rule: 'voicing/missing-announcement',
    layer: 'voicing',
    severity: 'moderate',
    // Promotion flips only classes the caller listed in config. This tier still never
    // decides verdicts and never writes config state.
    evidenceClass: promoted ? 'deterministic' : 'preview',
    screenId,
    elementPath,
    elementName: nameToken?.text ?? null,
    role: roleToken?.text ?? null,
    whatUserExperiences: `After step ${obligation.afterStep}, the expected announcement words were missing. Observed announcement text: ${observed}.`,
    why: `Obligation "${obligation.class}" requires tokens "${obligation.requiredTokens.join(', ')}" in this window, but they were not all present in the raw observed announcement text: ${observed}.`,
    fix: 'Ensure this interaction announces the required words in the same window, using visible naming and live-region updates where needed.',
    evidence: {
      ...(nameToken
        ? { name: { value: nameToken.text, fromTree: nameToken.fromTree, source: nameToken.source } }
        : {}),
      ...(roleToken
        ? { role: { value: roleToken.text, fromTree: roleToken.fromTree, source: roleToken.source } }
        : {}),
    },
    // Unverified keeps advisory misses out of gate authority unless caller promotion says otherwise.
    confidence: promoted ? 'fail' : 'unverified',
  };
}

export function runVoicingTier(
  contract: InteractionContract,
  stops: TranscriptStop[],
  screenId: string,
  promotedObligations: readonly string[] = [],
): Draft[] {
  const drafts: Draft[] = [];
  // Promotion is caller-provided policy. This unit may emit deterministic misses only
  // for listed classes, and it never writes promotion config.
  const promoted = new Set(promotedObligations);

  for (const obligation of contract.obligations) {
    const windowStop = stops.find((stop) => stop.index === obligation.afterStep);
    const isPromoted = promoted.has(obligation.class);

    if (!windowStop) {
      // Structural checks already report unreachable focus. This advisory draft records that
      // the obligation's word-level evidence is absent because the expected window was missing.
      drafts.push(makeMissingAnnouncementDraft(obligation, screenId, `step-${obligation.afterStep}`, isPromoted));
      continue;
    }

    if (obligationSatisfied(obligation.requiredTokens, windowStop.announcement)) {
      continue;
    }

    // Matching may normalize punctuation for comparison, but findings still quote raw text so
    // operators can read exactly what assistive technology announced.
    drafts.push(makeMissingAnnouncementDraft(obligation, screenId, windowStop.elementPath, isPromoted, windowStop));
  }

  return drafts;
}
