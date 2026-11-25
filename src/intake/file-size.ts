/**
 * The byte limit of one requirement file.
 *
 * A real requirement file holds a few KiB. The limit is checked before the file is parsed, so a
 * huge file is refused fast and is never read in part. Within it, the densest bad file the list
 * limits allow holds about 1.1 problems for each byte, so one at the limit holds about 143,000
 * problems, and refusing it stays under about 2 seconds and 256 MB.
 */
import type { BoundedTextRead } from '../contracts/index.js';

export const REQUIREMENT_FILE_BYTE_LIMIT = 128 * 1024;

export const REQUIREMENT_FILE_TOO_LARGE = 'a requirement file can be at most 128 KiB; split it into smaller files';

/** A text already read whole, checked against the limit by its size as UTF-8. */
export function textWithin(text: string | null, maxBytes: number): BoundedTextRead | null {
  if (text === null) {
    return null;
  }
  return Buffer.byteLength(text, 'utf8') > maxBytes ? { kind: 'too-large' } : { kind: 'text', text };
}
