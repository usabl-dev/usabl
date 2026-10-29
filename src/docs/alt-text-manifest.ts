/**
 * Alt text manifest generator for intake content requirements, and for screens without them,
 * drafted from the images the page showed.
 * This unit projects requirement bundle data, or scrubbed page data, into a doc artifact.
 * It must never invent evidence coverage, mutate Result state, or read time from the host clock.
 */
import type { DocArtifact, PageImage, RequirementBundle, Result, ScreenScan } from '../contracts/index.js';
import { MAX_PAGE_IMAGES } from '../providers/page-images.js';
import { buildEvidenceBinding } from './evidence-binding.js';

export function generateAltTextManifest(result: Result, bundle: RequirementBundle, surface: string): DocArtifact {
  // Receipt must come from Result so artifacts cannot be paired with detached proof.
  const binding = buildEvidenceBinding(result, surface);
  const entries: DocArtifact['entries'] = [];

  for (const requirement of bundle.requirements) {
    if (requirement.kind !== 'content' || requirement.surface !== surface) {
      continue;
    }
    if (requirement.assertion.type !== 'content' || requirement.assertion.expectedText === undefined) {
      continue;
    }

    // Surface coverage does not prove this selector's accessible name matched.
    // We bind the artifact to the receipt tree without minting selector-level pass evidence.
    entries.push({
      element: requirement.assertion.selector,
      content: requirement.assertion.expectedText,
      status: requirement.approved ? 'approved' : 'draft',
    });
  }

  return {
    kind: 'alt-text-manifest',
    surface,
    entries,
    generatedAt: binding.generatedAt,
    ...(binding.boundToReceipt === undefined ? {} : { boundToReceipt: binding.boundToReceipt }),
  };
}

// Page text is untrusted and has no length limit, so every string drafted from the page is cut to
// these lengths. A cut string ends with the marker, so a reader can see it was shortened.
export const MAX_DRAFTED_TEXT = 200;
const MAX_DRAFTED_ELEMENT = 300;
const SHORTENED = ' (shortened)';

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - SHORTENED.length).trimEnd() + SHORTENED;
}

function draftedContent(image: PageImage): string {
  const name = image.name?.trim() ?? '';
  if (name.length > 0) return shorten(name, MAX_DRAFTED_TEXT);
  if (image.decorative) return 'Marked decorative on the page.';
  return 'No text alternative on the page.';
}

/**
 * The alt-text manifest for a screen no content requirement covers, drafted from the images the
 * page showed. The caller passes a scrubbed Result, because the names are page text.
 *
 * Every entry is a draft marked as drafted from the page, and none carries evidence. The page's
 * own text is what a person reviews, not something usabl checked, so it can never read as proof,
 * as an approval, or as a requirement. The artifact binds to the receipt the same way every other
 * artifact does, so on a verified run it reads as bound without evidence.
 */
export function generatePageAltTextManifest(result: Result, screen: ScreenScan): DocArtifact {
  const binding = buildEvidenceBinding(result, screen.screenId);
  const entries: DocArtifact['entries'] = (screen.images ?? []).map((image) => ({
    element: shorten(image.elementPath, MAX_DRAFTED_ELEMENT),
    content: draftedContent(image),
    status: 'draft',
    origin: 'page',
  }));
  const notListed = screen.imagesNotListed ?? 0;
  if (notListed > 0) {
    entries.push({
      element: '(not listed)',
      content:
        `${String(notListed)} more ${notListed === 1 ? 'image' : 'images'} on this screen ` +
        `${notListed === 1 ? 'was' : 'were'} not listed. usabl lists at most ${String(MAX_PAGE_IMAGES)} images per screen.`,
      status: 'draft',
      origin: 'page',
    });
  }
  return {
    kind: 'alt-text-manifest',
    surface: screen.screenId,
    entries,
    generatedAt: binding.generatedAt,
    ...(binding.boundToReceipt === undefined ? {} : { boundToReceipt: binding.boundToReceipt }),
  };
}
