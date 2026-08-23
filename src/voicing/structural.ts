/**
 * Structural voicing checks for interaction contract windows.
 * This unit emits deterministic Draft observations only.
 * It must never mint a verdict and must never perform word-level obligation matching.
 */
import type { AnnouncementToken, Draft, InteractionContract, TranscriptStop } from '../contracts/index.js';

function nonEmptyText(text: string | null): text is string {
  return text !== null && text.trim().length > 0;
}

function firstNonEmptyToken(tokens: AnnouncementToken[], kind: AnnouncementToken['kind']): AnnouncementToken | null {
  const hit = tokens.find((token) => token.kind === kind && nonEmptyText(token.text));
  return hit ?? null;
}

function hasNonEmptyToken(tokens: AnnouncementToken[], kind: AnnouncementToken['kind']): boolean {
  return firstNonEmptyToken(tokens, kind) !== null;
}

function hasFocusedRole(tokens: AnnouncementToken[], focusedRole: string): boolean {
  const expected = focusedRole.trim().toLowerCase();
  return tokens.some((token) => token.kind === 'role' && nonEmptyText(token.text) && token.text.trim().toLowerCase() === expected);
}

function makeDraft(
  rule: string,
  screenId: string,
  elementPath: string,
  whatUserExperiences: string,
  why: string,
  fix: string,
  stop?: TranscriptStop,
): Draft {
  const roleToken = stop ? firstNonEmptyToken(stop.announcement, 'role') : null;
  const nameToken = stop ? firstNonEmptyToken(stop.announcement, 'name') : null;
  return {
    rule,
    layer: 'voicing',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId,
    elementPath,
    elementName: nameToken?.text ?? null,
    role: roleToken?.text ?? null,
    whatUserExperiences,
    why,
    fix,
    evidence: {
      ...(nameToken
        ? { name: { value: nameToken.text, fromTree: nameToken.fromTree, source: nameToken.source } }
        : {}),
      ...(roleToken
        ? { role: { value: roleToken.text, fromTree: roleToken.fromTree, source: roleToken.source } }
        : {}),
    },
    confidence: 'fail',
  };
}

export function runStructuralTier(contract: InteractionContract, stops: TranscriptStop[], screenId: string): Draft[] {
  const drafts: Draft[] = [];

  if (stops.length === 0) {
    drafts.push(
      makeDraft(
        'voicing/unreachable-focus',
        screenId,
        contract.surfaceId,
        'Keyboard focus never reached the interaction target.',
        `The interaction produced zero transcript stops for contract "${contract.contractId}".`,
        'Ensure the contract steps can move focus to the intended target element.',
      ),
    );
    return drafts;
  }

  for (const obligation of contract.obligations) {
    const windowStop = stops.find((stop) => stop.index === obligation.afterStep);
    if (!windowStop) {
      // A missing stop at the claimed obligation step means the contract window was not exercisable.
      drafts.push(
        makeDraft(
          'voicing/unreachable-focus',
          screenId,
          `step-${obligation.afterStep}`,
          `Keyboard focus did not reach the expected step ${obligation.afterStep} window.`,
          `No transcript stop exists for obligation "${obligation.class}" at step ${obligation.afterStep}.`,
          'Ensure the interaction steps can reach the obligation window by keyboard.',
        ),
      );
      continue;
    }

    // Name and role checks run only at obligation windows. Nameless targets outside these windows
    // can be legitimate navigation waypoints, and blanket checks here would duplicate walk findings.
    if (!hasNonEmptyToken(windowStop.announcement, 'name')) {
      drafts.push(
        makeDraft(
          'voicing/missing-name',
          screenId,
          windowStop.elementPath,
          `After step ${obligation.afterStep}, focus landed on an element without an accessible name.`,
          `Obligation "${obligation.class}" requires a named target at this window.`,
          'Add an accessible name by using visible text, aria-label, or aria-labelledby.',
          windowStop,
        ),
      );
    }

    if (obligation.focusedRole !== undefined && !hasFocusedRole(windowStop.announcement, obligation.focusedRole)) {
      drafts.push(
        makeDraft(
          'voicing/missing-role',
          screenId,
          windowStop.elementPath,
          `After step ${obligation.afterStep}, focus did not expose the required "${obligation.focusedRole}" role.`,
          `Obligation "${obligation.class}" expects focusedRole "${obligation.focusedRole}" at this window.`,
          `Ensure the target element exposes role "${obligation.focusedRole}" or the equivalent semantic element.`,
          windowStop,
        ),
      );
    }

    // mustAnnounce is structural here: a live token proves AT received any update.
    // Matching exact wording is a separate advisory layer.
    if (obligation.mustAnnounce && !hasNonEmptyToken(windowStop.announcement, 'live')) {
      drafts.push(
        makeDraft(
          'voicing/missing-live-announcement',
          screenId,
          windowStop.elementPath,
          `After step ${obligation.afterStep}, no live announcement reached assistive technology.`,
          `Obligation "${obligation.class}" requires an announced consequence, but no live token was observed in this window.`,
          'Render the consequence into an existing aria-live region such as role="status" or role="alert".',
          windowStop,
        ),
      );
    }
  }

  if (contract.maxTabPath !== undefined && stops.length > contract.maxTabPath) {
    drafts.push(
      makeDraft(
        'voicing/over-long-tab-path',
        screenId,
        contract.surfaceId,
        `Keyboard users needed ${stops.length} focus stops before the target window.`,
        `The observed tab path length exceeded maxTabPath ${contract.maxTabPath} in contract "${contract.contractId}".`,
        'Reduce early focus stops or provide a skip path to the target.',
      ),
    );
  }

  return drafts;
}
