/**
 * Plain words for why a drain cannot say which announcements a screen reader heard. The flow
 * requirement and the voicing tiers both explain this case, so the words live in one place.
 */
import type { AnnouncementUndecidable } from '../contracts/index.js';

const UNDECIDABLE_CAUSE: Record<AnnouncementUndecidable, string> = {
  'closed-shadow-modal':
    'a modal dialog is open inside a closed shadow root, so usabl cannot tell which live regions it hides from assistive technology',
  'changed-element-removed':
    'a modal dialog is open, and a live region that changed was removed before usabl could check whether the modal hid it',
};

export function announcementUndecidableCause(reason: AnnouncementUndecidable): string {
  return UNDECIDABLE_CAUSE[reason];
}

export const ANNOUNCEMENT_UNDECIDABLE_FIX =
  'Check this announcement by hand. To let usabl check it, keep modal dialogs out of closed shadow roots, and keep the live region in the document until the step ends.';
