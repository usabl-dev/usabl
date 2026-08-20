/** Lowercase, hyphenated, ascii-ish token safe for identity keys. */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
