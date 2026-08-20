/**
 * Fold an accessible name into an identity-key token.
 * Collisions (`Save` vs `save`) are accepted: this is a stable key, not a display string.
 * Page-derived text is untrusted; slugging is not an egress sanitizer.
 */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
