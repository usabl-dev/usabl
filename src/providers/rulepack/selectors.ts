/**
 * PatternFly 6 selector constants for static rulepack checks.
 * This unit must never claim coverage for a selector that never matches fixtures.
 */
export const SEL = {
  alert: '[class*="pf-v6-c-alert"]',
  liveContainer: '[aria-live], [role="status"], [role="alert"], [role="log"]',
  unnamedButton: 'button[aria-label=""], button:not([aria-label]):not([aria-labelledby])',
  menuToggle: '[aria-haspopup="menu"], [aria-haspopup="true"]',
  dialogTrigger: '[aria-haspopup="dialog"]',
  dialog: '[role="dialog"], [role="alertdialog"]',
  menu: '[role="menu"], [role="listbox"]',
  toolbar: '[class*="pf-v6-c-toolbar"]',
  rowActionButton: 'td button, td [role="button"]',
  unscopedTh: 'table th:not([scope]):not([id])',
} as const;
