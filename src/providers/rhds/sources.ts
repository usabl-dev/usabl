/**
 * Source sentences for the Red Hat Design System (RHDS) rulepack.
 *
 * Every rule quotes the RHDS sentence it enforces, word for word, and checks nothing the quote does
 * not say. The quotes come from custom-elements.json in the pinned package version, the manifest
 * that also feeds the RHDS element pages, so each rule traces to the release it was written against.
 * test/providers/rhds/sources.test.ts checks every quote, and the tag list below, against that file.
 */

export const RHDS_PACKAGE = '@rhds/elements';
export const RHDS_VERSION = '5.0.0';

export interface RhdsSource {
  element: string;
  quote: string;
}

export const RHDS_SOURCES = {
  'rhds-button-accessible-label': [
    {
      element: 'rh-button',
      quote: 'Icon-only buttons must set `accessible-label` to provide an ARIA accessible name.',
    },
  ],
  'rhds-cta-link': [
    { element: 'rh-cta', quote: 'Must contain an `href` attribute or a slotted `<a>` / `<button>`.' },
    { element: 'rh-cta', quote: 'Slot an anchor or button as the first child, or set href on the host.' },
  ],
  'rhds-tabs-paired': [
    { element: 'rh-tabs', quote: 'Each tab must be paired with a corresponding `rh-tab-panel`.' },
    { element: 'rh-tabs', quote: 'Each tab must have a corresponding `<rh-tab-panel>` in the default slot.' },
  ],
  'rhds-dialog-name': [
    { element: 'rh-dialog', quote: 'Must have a heading or `accessible-label` for screen readers.' },
    {
      element: 'rh-dialog',
      quote: 'Its text is used as a fallback accessible name when no heading or `accessible-label` is present.',
    },
  ],
  'rhds-switch-label': [
    {
      element: 'rh-switch',
      quote: 'Authors must supply an accessible label via `accessible-label` or a `<label for>`.',
    },
  ],
  'rhds-accordion-header-parent': [
    { element: 'rh-accordion-header', quote: 'Must be a direct child of `rh-accordion`.' },
  ],
  'rhds-skip-link-target': [
    {
      element: 'rh-skip-link',
      quote: 'authors must provide either an `href` attribute or a slotted `<a>` element.',
    },
    {
      element: 'rh-skip-link',
      quote: 'URL fragment (e.g. `#main-content`) identifying the target element to skip to.',
    },
  ],
} as const satisfies Record<string, readonly RhdsSource[]>;

export type RhdsRuleId = keyof typeof RHDS_SOURCES;

/** Every rule the pack can emit, sorted, for the applicability record. */
export const RHDS_RULES: readonly RhdsRuleId[] = (Object.keys(RHDS_SOURCES) as RhdsRuleId[]).sort();

/**
 * Every element the pinned release defines. The pack runs only on a page that holds at least one
 * of them. CSS has no selector for a tag name prefix, so the marker lists the tags, and the sources
 * test keeps the list equal to the tags in the manifest. A tag a later release adds is not in the
 * list, and none of the rules below checks it either.
 */
export const RHDS_TAGS: readonly string[] = [
  'rh-accordion',
  'rh-accordion-header',
  'rh-accordion-panel',
  'rh-alert',
  'rh-announcement',
  'rh-audio-player',
  'rh-audio-player-about',
  'rh-audio-player-rate-stepper',
  'rh-audio-player-scrolling-text-overflow',
  'rh-audio-player-subscribe',
  'rh-avatar',
  'rh-back-to-top',
  'rh-badge',
  'rh-blockquote',
  'rh-breadcrumb',
  'rh-button',
  'rh-button-group',
  'rh-card',
  'rh-chip',
  'rh-chip-group',
  'rh-code-block',
  'rh-context-demo',
  'rh-context-picker',
  'rh-cta',
  'rh-cue',
  'rh-dialog',
  'rh-disclosure',
  'rh-footer',
  'rh-footer-block',
  'rh-footer-copyright',
  'rh-footer-links',
  'rh-footer-social-link',
  'rh-footer-universal',
  'rh-health-index',
  'rh-icon',
  'rh-jump-link',
  'rh-jump-links',
  'rh-jump-links-list',
  'rh-menu',
  'rh-menu-dropdown',
  'rh-menu-item',
  'rh-menu-item-group',
  'rh-navigation-link',
  'rh-navigation-primary',
  'rh-navigation-primary-item',
  'rh-navigation-primary-item-menu',
  'rh-navigation-secondary',
  'rh-navigation-secondary-dropdown',
  'rh-navigation-secondary-menu',
  'rh-navigation-secondary-menu-section',
  'rh-navigation-secondary-overlay',
  'rh-navigation-vertical',
  'rh-navigation-vertical-list',
  'rh-option',
  'rh-option-group',
  'rh-pagination',
  'rh-progress-step',
  'rh-progress-stepper',
  'rh-readtime',
  'rh-scheme-dropdown',
  'rh-scheme-toggle',
  'rh-select',
  'rh-site-status',
  'rh-skeleton',
  'rh-skip-link',
  'rh-sort-button',
  'rh-spinner',
  'rh-stat',
  'rh-subnav',
  'rh-surface',
  'rh-switch',
  'rh-tab',
  'rh-tab-panel',
  'rh-table',
  'rh-tabs',
  'rh-tag',
  'rh-tile',
  'rh-tile-group',
  'rh-timestamp',
  'rh-tooltip',
  'rh-transcript',
  'rh-video-embed',
];

/** The rule's source sentences as they open a draft's `why`, each followed by its element. */
export function quotedSources(rule: RhdsRuleId): string {
  const sources: readonly RhdsSource[] = RHDS_SOURCES[rule];
  return sources.map((source) => `"${source.quote}" (${source.element}, RHDS ${RHDS_VERSION})`).join(' ');
}
