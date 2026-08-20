/**
 * Rule-specific guidance for common axe findings.
 * These notes help Draft text stay actionable, but they must never decide a verdict.
 */
export interface AxeNote {
  why: string;
  fix: string;
}

const EMPTY_NOTE: AxeNote = { why: '', fix: '' };

const NOTES_BY_RULE: Record<string, AxeNote> = {
  'color-contrast': {
    why: 'Text and PatternFly actions with low contrast are hard to read, especially in low vision contexts.',
    fix: 'Adjust styles to meet WCAG AA 4.5:1 contrast or switch to a semantic token that already meets the ratio.',
  },
  'button-name': {
    why: 'An unnamed button gives assistive technology no clear action to announce.',
    fix: 'Provide visible text, aria-label, or aria-labelledby. PatternFly icon-only buttons need an aria-label.',
  },
  'image-alt': {
    why: 'Missing alt text can make images get skipped or announced as filenames.',
    fix: 'Add descriptive alt text, or use an empty alt for decorative images. PatternFly Brand must provide alt text.',
  },
  label: {
    why: 'Inputs without labels force assistive technology users to guess the field purpose.',
    fix: 'Connect a FormLabel htmlFor to the control id, or provide aria-labelledby.',
  },
  'aria-required-children': {
    why: 'Required owned roles are missing, so composite widgets expose incomplete structure.',
    fix: 'Add the required role relationships, such as listbox containing option elements.',
  },
};

export function noteFor(ruleId: string): AxeNote {
  return NOTES_BY_RULE[ruleId] ?? EMPTY_NOTE;
}
