/**
 * Reads the images a screen shows, for the alt-text manifest the docs generator drafts.
 * This is not a provider. It emits no drafts, no gaps, and no applicability, and the gate never
 * reads what it returns. The check runner calls it only when the docs generator asks.
 *
 * The name and role come from the accessibility tree, the same source the checks trust. They are
 * page text, so they stay untrusted: the docs surface scrubs and shortens them before output and
 * labels every entry as drafted from the page.
 */
import type { AncestorAttributesRead, Page, PageImage } from '../contracts/index.js';

// Elements that present an image to assistive technology. role="image" is the ARIA 1.3 synonym.
export const IMAGE_SELECTOR = 'img, [role="img"], [role="image"], input[type="image"]';

// A screen can render thousands of images, such as a table of avatars. The read stops listing at
// this cap so one screen cannot make the run slow or the manifest unreadable. The rest are counted.
export const MAX_PAGE_IMAGES = 200;

const OWN_ATTRIBUTES = ['alt', 'role'] as const;
const DECORATIVE_ROLES = new Set(['none', 'presentation']);

/**
 * Whether the page marks the image as decorative. The first element of the chain is the image
 * itself, and only its own attributes count. The first token of a role list is the role a browser
 * uses, so only that token is read.
 */
function isDecorative(treeRole: string | null, attributes: AncestorAttributesRead): boolean {
  if (treeRole !== null && DECORATIVE_ROLES.has(treeRole)) return true;
  const own = attributes.kind === 'chain' ? attributes.chain[0] : undefined;
  if (own === undefined) return false;
  const roleToken = (own['role'] ?? '').trim().toLowerCase().split(/\s+/u)[0] ?? '';
  return own['alt'] === '' || DECORATIVE_ROLES.has(roleToken);
}

export interface PageImagesRead {
  images: PageImage[];
  notListed: number;
}

/**
 * Lists the images in document order, which is a property of the DOM and not of timing, so the
 * same page reads the same way every time. It throws when the page cannot be read, and the caller
 * decides what that means.
 */
export async function readPageImages(page: Page): Promise<PageImagesRead> {
  const matches = await page.queryAll(IMAGE_SELECTOR);
  const listed = matches.slice(0, MAX_PAGE_IMAGES);
  const images: PageImage[] = [];
  for (const match of listed) {
    const node = await page.axAt(match.selector);
    images.push({
      elementPath: match.selector,
      name: node?.name ?? null,
      role: node?.role ?? null,
      decorative: isDecorative(node?.role ?? null, await page.ancestorAttributes(match.selector, OWN_ATTRIBUTES)),
    });
  }
  return { images, notListed: matches.length - listed.length };
}
