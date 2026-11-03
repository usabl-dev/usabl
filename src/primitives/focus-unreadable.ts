/**
 * Plain words for why the element that has focus cannot be read, shared by every check that reads
 * focus. A check that cannot read the focused control has no evidence about it, so it must say so
 * as a gap and never report a missing name or role as a barrier.
 */
import type { FocusUnreadable } from '../contracts/index.js';

const CAUSE: Record<FocusUnreadable, string> = {
  'closed-shadow-root': 'focus is inside a closed shadow root, where usabl cannot tell one control from another',
  'frame-unreadable':
    'focus is inside a frame usabl cannot read, such as one from another origin or the frame of an object, embed, or fencedframe element',
  'focus-too-deep': 'focus sits under more shadow roots and frames than usabl follows',
};

/** The cause as a clause that can follow "because" or start a sentence after a capital. */
export function focusUnreadableCause(reason: FocusUnreadable): string {
  return CAUSE[reason];
}

export const FOCUS_UNREADABLE_FIX =
  'Check this control by hand. To let usabl read it, use an open shadow root, or serve the frame from the same origin as the screen in an iframe.';
