/**
 * Voicing comparator helpers for obligation matching only.
 * This unit normalizes comparator inputs, then checks required phrases.
 * It must never rewrite finding display text or mint any verdict signal.
 */

/**
 * Normalization is comparison-only. It removes punctuation variance so matching can
 * stay honest while later reporting still quotes the raw observed announcement text.
 */
export function normalizeToken(raw: string | null): string {
  if (raw === null) {
    return '';
  }

  return raw.toLowerCase().replace(/[^\w\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function obligationSatisfied(required: string[], announcements: Array<{ text: string | null }>): boolean {
  // Compare normalized text on both sides so punctuation and spacing in transcripts
  // cannot fabricate a miss, and cannot hide a real hit.
  // Join with spaces so phrases can match across adjacent announcement tokens.
  // Include all announcement texts here because toast outcomes can arrive only as live tokens.
  const haystack = announcements
    .map((token) => normalizeToken(token.text))
    .filter((token) => token.length > 0)
    .join(' ');

  return required.every((token) => {
    const normalized = normalizeToken(token);
    return normalized.length === 0 || haystack.includes(normalized);
  });
}
