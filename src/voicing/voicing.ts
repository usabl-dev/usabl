/**
 * Word-level voicing advisory checks for interaction contract windows.
 * This unit emits preview Draft observations only.
 * It must never mint a verdict, perform promotion, or rewrite display text.
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
  stop?: TranscriptStop,
): Draft {
  const roleToken = stop ? firstNonEmptyToken(stop.announcement, 'role') : null;
  const nameToken = stop ? firstNonEmptyToken(stop.announcement, 'name') : null;
  const observed = observedTextQuote(stop);
  return {
    rule: 'voicing/missing-announcement',
    layer: 'voicing',
    severity: 'moderate',
    evidenceClass: 'preview',
    screenId,
    elementPath,
    elementName: nameToken?.text ?? null,
    role: roleToken?.text ?? null,
    whatUserExperiences: `After step ${obligation.afterStep}, the expected announcement words were missing. Observed announcement text: ${observed}.`,
    // Word misses are advisory here because normalized comparison can suggest a gap, but only
    // reproducible deterministic evidence can gate a verdict.
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
    confidence: 'unverified',
  };
}

export function runVoicingTier(contract: InteractionContract, stops: TranscriptStop[], screenId: string): Draft[] {
  const drafts: Draft[] = [];

  for (const obligation of contract.obligations) {
    const windowStop = stops.find((stop) => stop.index === obligation.afterStep);

    if (!windowStop) {
      // Structural checks already report unreachable focus. This advisory draft records that
      // the obligation's word-level evidence is absent because the expected window was missing.
      drafts.push(makeMissingAnnouncementDraft(obligation, screenId, `step-${obligation.afterStep}`));
      continue;
    }

    if (obligationSatisfied(obligation.requiredTokens, windowStop.announcement)) {
      continue;
    }

    // Matching may normalize punctuation for comparison, but findings still quote raw text so
    // operators can read exactly what assistive technology announced.
    drafts.push(makeMissingAnnouncementDraft(obligation, screenId, windowStop.elementPath, windowStop));
  }

  return drafts;
}
