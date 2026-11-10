/**
 * The one list of BoxLimit names, in the order they are reported. The box read in the browser
 * writes these names, and the target size check reads them in this order, so the two can never
 * hold different lists. The record has to name every BoxLimit, so a new one that is left out of
 * it does not compile.
 */
import type { BoxLimit } from '../contracts/index.js';

const RANK: Readonly<Record<BoxLimit, number>> = {
  'rotated-or-skewed': 0,
  'clip-path': 1,
  mask: 2,
  'overflow-clipped': 3,
  'outside-viewport': 4,
  'hit-test-missed': 5,
  'size-changed-on-scroll': 6,
};

export const BOX_LIMITS: readonly BoxLimit[] = (Object.keys(RANK) as BoxLimit[]).sort((a, b) => RANK[a] - RANK[b]);
