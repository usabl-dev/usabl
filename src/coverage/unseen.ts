/**
 * Unseen-screen detection: which scanned screens the engine has no grounds to claim it measured.
 *
 * A scan can finish without an error and still never have reached the application. An
 * unauthenticated route, a component that threw on mount, and a wrong URL all settle into a
 * stable document with nothing in it, and axe then fires the same few document-level rules on
 * every one of them. Readiness cannot separate those cases from a legitimately empty list,
 * because all four settle, so the split is made here from what the scan actually returned.
 *
 * The findings are dropped, not downgraded. The gate weighs a new failure before it weighs
 * missing coverage on purpose, because a real new barrier is the actionable answer. Leaving
 * these drafts in place with a gap beside them would still mint regression from a document
 * nobody rendered.
 *
 * There is no element-count threshold here. A blank screen of a real application still carries
 * a few hundred head elements, so a count would only be another number to tune.
 *
 * This unit reports coverage. It must never mint a verdict.
 */
import type { CoverageGap, Draft, ScreenScan } from '../contracts/index.js';
import { computeIdentity } from '../primitives/identity.js';

export interface UnseenPass {
  screens: ScreenScan[]; // same order as the input, unseen screens stripped of drafts and applicability
  unseenScreenIds: string[];
}

/**
 * A live blank page reports the document body for every tab press. The page driver writes an
 * nth-child ancestry, so the body arrives as `html > body:nth-child(2)` rather than a bare tag
 * name, and a body carrying an id would arrive as that id instead. Match the tail segment so
 * both real shapes are covered without parsing a selector.
 */
function isDocumentBody(elementPath: string): boolean {
  const tail = elementPath.split('>').at(-1)?.trim() ?? '';
  return tail === 'body' || tail.startsWith('body:');
}

/**
 * The observed signature from a login-gated application scanned with no session: fifty tab
 * presses, focus never off the body, nothing focusable anywhere on the page.
 *
 * An empty transcript is not this. It means no keyboard walk was recorded, which is the absence
 * of evidence rather than evidence the screen was blank.
 */
function isBodyOnly(scan: ScreenScan): boolean {
  return scan.stops.length > 0 && scan.stops.every((stop) => isDocumentBody(stop.elementPath));
}

/**
 * A screen-independent identity for a draft. computeIdentity keys on the screen id, which is
 * exactly what makes two renders of the same blank document look like two different findings,
 * so the screen id is blanked before comparing screens to each other.
 */
function identityAcrossScreens(draft: Draft): string {
  const { elementKey } = computeIdentity({ ...draft, screenId: '' });
  return `${draft.layer}|${draft.rule}|${elementKey ?? 'count'}`;
}

/**
 * What a screen measured, independent of which screen it was. Null when the screen produced no
 * drafts: two clean screens share an empty result, and that is the absence of evidence, not
 * evidence that they are the same page.
 */
function measuredFingerprint(scan: ScreenScan): string | null {
  if (scan.drafts.length === 0) {
    return null;
  }
  return scan.drafts.map(identityAcrossScreens).sort().join('\n');
}

/**
 * Screens that measured identically at different URLs, keyed by screen id to the other screen
 * ids in the same group. Distinct URLs are the whole point: one URL scanned under two profiles
 * can honestly report the same identities, two different URLs cannot.
 */
function duplicateRenders(screens: ScreenScan[]): Map<string, string[]> {
  const byFingerprint = new Map<string, ScreenScan[]>();
  for (const scan of screens) {
    const fingerprint = measuredFingerprint(scan);
    if (fingerprint === null) {
      continue;
    }
    byFingerprint.set(fingerprint, [...(byFingerprint.get(fingerprint) ?? []), scan]);
  }

  const duplicates = new Map<string, string[]>();
  for (const group of byFingerprint.values()) {
    if (new Set(group.map((scan) => scan.url)).size < 2) {
      continue;
    }
    for (const scan of group) {
      duplicates.set(
        scan.screenId,
        group.filter((other) => other.screenId !== scan.screenId).map((other) => other.screenId),
      );
    }
  }
  return duplicates;
}

function unseenGap(scan: ScreenScan, detectorSentences: string[]): CoverageGap {
  return {
    ref: scan.url,
    state: 'not-covered',
    reason: [
      'usabl did not see this screen, so its findings were dropped.',
      ...detectorSentences,
      'Check the URL and any sign-in this run needs before trusting a verdict for it.',
    ].join(' '),
  };
}

/**
 * Strip drafts and applicability from every screen the engine cannot claim it saw and disclose
 * each one as a coverage gap. Screens that were really walked pass through untouched, gaps and all.
 *
 * The duplicate-render check compares screens to each other, so it cannot live inside a single
 * screen's scan and this pass runs over the whole collected set.
 */
export function markUnseenScreens(screens: ScreenScan[]): UnseenPass {
  const duplicates = duplicateRenders(screens);
  const unseenScreenIds: string[] = [];

  const marked = screens.map((scan) => {
    const sentences: string[] = [];
    if (isBodyOnly(scan)) {
      sentences.push(
        'Every keyboard stop stayed on the document body, so the page had nothing to walk; a page ' +
          'that never rendered, one behind a login, and one that threw on mount all look like this.',
      );
    }
    const sameAs = duplicates.get(scan.screenId);
    if (sameAs !== undefined) {
      sentences.push(
        `It reported the same finding identities as ${sameAs.join(', ')}, which are different URLs, ` +
          'and two different screens do not measure identically.',
      );
    }
    if (sentences.length === 0) {
      return scan;
    }
    unseenScreenIds.push(scan.screenId);
    // Applicability goes with the drafts, for the same reason. Sixty rules reported inapplicable
    // against a document that never rendered is a fact about a blank page, not about the
    // application, and keeping it would put the dropped claim back in a quieter form.
    return { ...scan, drafts: [], applicability: [], gaps: [...scan.gaps, unseenGap(scan, sentences)] };
  });

  return { screens: marked, unseenScreenIds };
}
