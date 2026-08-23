import { describe, expect, it } from 'vitest';
import type { AnnouncementToken } from '../../src/contracts/index.js';
import { obligationSatisfied } from '../../src/voicing/normalize.js';

const name = (text: string): AnnouncementToken => ({
  kind: 'name',
  text,
  fromTree: true,
  source: 'ax-tree',
});

const live = (text: string): AnnouncementToken => ({
  kind: 'live',
  text,
  fromTree: false,
  source: 'attribute',
});

describe('obligationSatisfied', () => {
  it('ignores punctuation differences in observed text', () => {
    expect(obligationSatisfied(['cluster deleted successfully'], [name('Cluster deleted, successfully.')])).toBe(true);
  });

  it('matches required phrases that span adjacent tokens', () => {
    expect(obligationSatisfied(['confirm deletion'], [name('Confirm'), name('deletion')])).toBe(true);
  });

  it('uses live tokens when toasts only arrive as live announcements', () => {
    expect(obligationSatisfied(['Cluster deleted'], [name('Delete'), live('Cluster deleted successfully')])).toBe(true);
  });

  it('keeps genuine misses as misses', () => {
    expect(obligationSatisfied(['Cluster deleted'], [name('Loading')])).toBe(false);
  });

  it('requires every required token to be present', () => {
    expect(obligationSatisfied(['Cluster deleted', 'success'], [live('Cluster deleted')])).toBe(false);
    expect(obligationSatisfied(['Cluster deleted', 'success'], [live('Cluster deleted'), live('Alert: success')])).toBe(
      true,
    );
  });
});
