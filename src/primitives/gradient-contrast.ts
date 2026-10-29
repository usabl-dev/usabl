/**
 * Recognizes the one axe result that a gradient background causes: color-contrast left as needs
 * review because axe could not read a single background color. PatternFly 6 buttons draw their
 * background as a gradient, so one screen can carry dozens of these.
 *
 * The match is exact on purpose. axe-core 4.13.0 sets the check's messageKey to "bgGradient" only
 * when the element's background-image is a gradient. A background image, an overlapping element,
 * equal colors, and every other reason stay their own results, and so does any contrast result axe
 * did measure. This only names a result. It never changes a verdict, an identity, or the floor.
 */
import type { Draft } from '../contracts/index.js';

// The color-contrast check's incomplete reason for a background gradient in axe-core 4.13.0.
export const AXE_GRADIENT_REASON = 'bgGradient';

function messageKeyOf(draft: Draft): unknown {
  const axeData = draft.evidence.extra?.['axeData'];
  if (typeof axeData !== 'object' || axeData === null || Array.isArray(axeData)) return undefined;
  return (axeData as Record<string, unknown>)['messageKey'];
}

/** True for an axe color-contrast needs-review result that axe could not measure due to a gradient. */
export function isGradientContrastReview(draft: Draft): boolean {
  return (
    draft.layer === 'axe' &&
    draft.rule === 'color-contrast' &&
    draft.confidence === 'unverified' &&
    messageKeyOf(draft) === AXE_GRADIENT_REASON
  );
}

// The words every surface uses for these results. Fixed strings, never page-derived.
export const GRADIENT_CONTRAST_EXPERIENCE =
  'Needs review: axe could not measure the color contrast, because the background is a gradient.';
export const GRADIENT_CONTRAST_WHY =
  'axe reads one background color behind text. A gradient has many, so axe cannot work out a ' +
  'contrast ratio and asks a person to check.';
export const GRADIENT_CONTRAST_CHECK =
  'Check the text against the lightest and the darkest part of the gradient behind it. Each needs ' +
  'at least 4.5:1, or 3:1 for large text.';
