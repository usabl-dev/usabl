/**
 * Structural voicing checks for interaction contract windows.
 * This unit emits preview Draft observations by default, and deterministic ones only for obligation
 * classes the caller lists as promoted. Every class measured below the promotion bar, so nothing
 * from this tier may block a run until a person promotes the class in the trusted config.
 * It must never mint a verdict and must never perform word-level obligation matching.
 */
import type { AnnouncementToken, Draft, InteractionContract, SpeechObligation, TranscriptStop } from '../contracts/index.js';
import { FOCUS_UNREADABLE_FIX, focusUnreadableCause } from '../primitives/focus-unreadable.js';

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
  counted: boolean,
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
    // Only a promoted class gates. A preview draft never carries fail, so it cannot read as a
    // blocking barrier on any surface that counts failures.
    evidenceClass: counted ? 'deterministic' : 'preview',
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
    confidence: counted ? 'fail' : 'unverified',
  };
}

// Name and role checks run only at obligation windows. Nameless targets outside these windows
// can be legitimate navigation waypoints, and blanket checks here would duplicate walk findings.
function pushNameAndRoleDrafts(
  drafts: Draft[],
  obligation: SpeechObligation,
  windowStop: TranscriptStop,
  screenId: string,
  counted: boolean,
): void {
  if (!hasNonEmptyToken(windowStop.announcement, 'name')) {
    drafts.push(
      makeDraft(
        'voicing/missing-name',
        counted,
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
        counted,
        screenId,
        windowStop.elementPath,
        `After step ${obligation.afterStep}, focus did not expose the required "${obligation.focusedRole}" role.`,
        `Obligation "${obligation.class}" expects focusedRole "${obligation.focusedRole}" at this window.`,
        `Ensure the target element exposes role "${obligation.focusedRole}" or the equivalent semantic element.`,
        windowStop,
      ),
    );
  }
}

export function runStructuralTier(
  contract: InteractionContract,
  stops: TranscriptStop[],
  screenId: string,
  promotedObligations: readonly string[] = [],
): Draft[] {
  const drafts: Draft[] = [];
  // Promotion is caller-provided policy, read only. A window draft gates when its own obligation
  // class is promoted. A draft about the whole contract gates only when every obligation class in
  // the contract is promoted, because a person has then opted the whole contract in.
  const promoted = new Set(promotedObligations);
  const wholeContractCounted = contract.obligations.every((obligation) => promoted.has(obligation.class));

  if (stops.length === 0) {
    drafts.push(
      makeDraft(
        'voicing/unreachable-focus',
        wholeContractCounted,
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
    const counted = promoted.has(obligation.class);
    const windowStop = stops.find((stop) => stop.index === obligation.afterStep);
    if (!windowStop) {
      // A missing stop at the claimed obligation step means the contract window was not exercisable.
      drafts.push(
        makeDraft(
          'voicing/unreachable-focus',
          counted,
          screenId,
          `step-${obligation.afterStep}`,
          `Keyboard focus did not reach the expected step ${obligation.afterStep} window.`,
          `No transcript stop exists for obligation "${obligation.class}" at step ${obligation.afterStep}.`,
          'Ensure the interaction steps can reach the obligation window by keyboard.',
        ),
      );
      continue;
    }

    // When the focused element cannot be read, the stop holds no name or role of the control, so
    // their absence proves nothing. The window is a gap, never a missing-name or missing-role fail.
    // The live check below still runs: what the capture heard does not depend on the focus read.
    if (windowStop.focusUnreadable !== undefined) {
      drafts.push({
        ...makeDraft(
          'voicing/focus-unreadable',
          counted,
          screenId,
          windowStop.elementPath,
          `After step ${obligation.afterStep}, usabl could not read the focused control, so whether it has a name and role is unknown.`,
          `Obligation "${obligation.class}" needs the focused control at this window, but ${focusUnreadableCause(windowStop.focusUnreadable)}.`,
          FOCUS_UNREADABLE_FIX,
          windowStop,
        ),
        confidence: 'unverified',
      });
    } else {
      pushNameAndRoleDrafts(drafts, obligation, windowStop, screenId, counted);
    }

    // mustAnnounce is structural here: a live token proves AT received any update.
    // Matching exact wording is a separate advisory layer.
    if (obligation.mustAnnounce && !hasNonEmptyToken(windowStop.announcement, 'live')) {
      drafts.push(
        makeDraft(
          'voicing/missing-live-announcement',
          counted,
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
        wholeContractCounted,
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
