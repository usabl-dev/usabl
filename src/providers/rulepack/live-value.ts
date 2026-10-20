/**
 * Resolves the effective aria-live value of an element, the way WAI-ARIA defines it.
 *
 * The live value of content is the value on the nearest element, the content's own element or an
 * ancestor, that sets one. An element sets one in two ways: an explicit aria-live attribute, or a
 * role with an implicit live value. The explicit attribute wins over the role on the same element.
 * Nothing in the chain sets a value means the attribute default, off.
 *
 * Attribute handling follows the WAI-ARIA rules for author errors:
 * - An empty aria-live counts as not set, so the role, and then the ancestors, decide.
 * - An unknown aria-live token takes the attribute default, off. Chromium treats it as not set
 *   instead, so a role="status" host with a bad token can still speak there. Reading it as off is
 *   the stricter choice: it can report an alert that a browser would announce, but it can never
 *   pass an alert that a browser keeps silent.
 * - Token values compare without regard to ASCII case, so "OFF" is off and "POLITE" is polite.
 *
 * Only polite and assertive are live. Anything else is off. That is a positive list on purpose: a
 * test of "anything that is not exactly off" reads every odd spelling as live.
 */

export type LiveValue = 'off' | 'polite' | 'assertive';

/** The two attributes that decide one element's own live value, as read from the DOM. */
export interface LiveAttributes {
  ariaLive: string | null;
  role: string | null;
}

// Roles with an implicit aria-live value, from WAI-ARIA 1.2.
const IMPLICIT_LIVE: Readonly<Record<string, LiveValue>> = {
  alert: 'assertive',
  log: 'polite',
  status: 'polite',
  marquee: 'off',
  timer: 'off',
};

// Every concrete role a browser recognizes: WAI-ARIA 1.2 and 1.3, Graphics ARIA, and DPUB-ARIA.
// A role attribute is a list, and the browser uses the first token it recognizes. Without this
// list, an unknown first token would hide the real role behind it, so role="banana timer" would
// read as having no role and a polite region above it would wrongly reach the content.
const KNOWN_ROLES: ReadonlySet<string> = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption',
  'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'comment', 'complementary',
  'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed',
  'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'image', 'img',
  'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math',
  'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation',
  'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup',
  'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'sectionfooter',
  'sectionheader', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript',
  'suggestion', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term',
  'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
  'graphics-document', 'graphics-object', 'graphics-symbol',
  'doc-abstract', 'doc-acknowledgments', 'doc-afterword', 'doc-appendix', 'doc-backlink',
  'doc-biblioentry', 'doc-bibliography', 'doc-biblioref', 'doc-chapter', 'doc-colophon',
  'doc-conclusion', 'doc-cover', 'doc-credit', 'doc-credits', 'doc-dedication', 'doc-endnote',
  'doc-endnotes', 'doc-epigraph', 'doc-epilogue', 'doc-errata', 'doc-example', 'doc-footnote',
  'doc-foreword', 'doc-glossary', 'doc-glossref', 'doc-index', 'doc-introduction', 'doc-noteref',
  'doc-notice', 'doc-pagebreak', 'doc-pagefooter', 'doc-pageheader', 'doc-pagelist', 'doc-part',
  'doc-preface', 'doc-prologue', 'doc-pullquote', 'doc-qna', 'doc-subtitle', 'doc-tip', 'doc-toc',
]);

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/** The first recognized role in a role attribute, or null when it names none. */
export function firstRecognizedRole(role: string | null): string | null {
  if (role === null) {
    return null;
  }
  for (const token of asciiLower(role).split(/[\t\n\f\r ]+/)) {
    if (KNOWN_ROLES.has(token)) {
      return token;
    }
  }
  return null;
}

/** The live value this one element sets, or null when it sets none and its ancestors decide. */
export function ownLiveValue(node: LiveAttributes): LiveValue | null {
  if (node.ariaLive !== null && node.ariaLive !== '') {
    const token = asciiLower(node.ariaLive);
    return token === 'polite' || token === 'assertive' ? token : 'off';
  }
  const role = firstRecognizedRole(node.role);
  return role === null ? null : (IMPLICIT_LIVE[role] ?? null);
}

/**
 * The effective live value for a chain of elements, nearest first: the element itself, then its
 * parent, and so on to the root. An empty chain is off.
 */
export function effectiveLiveValue(chain: readonly LiveAttributes[]): LiveValue {
  for (const node of chain) {
    const own = ownLiveValue(node);
    if (own !== null) {
      return own;
    }
  }
  return 'off';
}
