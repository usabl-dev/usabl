/**
 * Resolves the effective aria-live value of an element, the way WAI-ARIA defines it.
 *
 * The live value of content is the value on the nearest element, the content's own element or an
 * ancestor, that sets one. An element sets one in two ways: an explicit aria-live attribute, or a
 * role with an implicit live value. The explicit attribute wins over the role on the same element.
 * Nothing in the chain sets a value means the attribute default, off.
 *
 * The rule for this module: it never passes an alert that a browser or screen reader may keep
 * silent. Each choice below follows from that.
 *
 * - Only the exact lowercase tokens "polite" and "assertive" are live. Every other non-empty
 *   aria-live value is off, and it stops the walk the way an explicit off does. WAI-ARIA 1.2 does
 *   not map an unknown value to the default. It tells browsers to expose the value as written,
 *   and Chromium does: aria-live="banana" and aria-live="POLITE" reach the accessibility API as
 *   "banana" and "POLITE". Nothing shows that screen readers treat "POLITE" as polite. Reading
 *   every such value as off can only make an alert less live, so it cannot pass a silent alert.
 * - An empty aria-live counts as not set, so the role, and then the ancestors, decide. Chromium
 *   does the same: an empty value exposes no live value of its own.
 * - Role names match without regard to ASCII case. WAI-ARIA 1.2 leaves role case to the host
 *   language, and Chromium matches role="STATUS" as status and role="TIMER" as timer. Exact-case
 *   matching here would be unsafe, not stricter: it would skip role="TIMER", whose implicit value
 *   is off, and let a polite region above it pass a silent alert.
 *
 * Only polite and assertive are live. That is a positive list on purpose: a test of "anything
 * that is not exactly off" reads every odd spelling as live.
 */

export type LiveValue = 'off' | 'polite' | 'assertive';

/** The two attributes that decide one element's own live value, as read from the DOM. */
export interface LiveAttributes {
  ariaLive: string | null;
  role: string | null;
}

/**
 * The facts that decide whether one element hides itself and everything under it from assistive
 * technology, as read from the DOM. inert and hidden are true when the attribute is present,
 * whatever its value. closedDialog is true for an HTML dialog element without the open attribute:
 * the browser does not render a closed dialog's content and leaves it out of the accessibility
 * tree.
 */
export interface HiddenAttributes {
  ariaHidden: string | null;
  inert: boolean;
  hidden: boolean;
  closedDialog: boolean;
}

/** Whether one element is a modal dialog that is open now, as the browser's :modal reads it. */
export interface ModalState {
  modal: boolean;
}

/** The attributes that make an element an ARIA modal dialog. */
export interface AriaModalAttributes {
  role: string | null;
  ariaModal: string | null;
}

/** The resolver's functions. See createLiveResolver. */
export interface LiveResolver {
  firstRecognizedRole(role: string | null): string | null;
  ownLiveValue(node: LiveAttributes): LiveValue | null;
  nearestLiveSetter(chain: readonly LiveAttributes[]): number;
  effectiveLiveValue(chain: readonly LiveAttributes[]): LiveValue;
  hiddenInChain(chain: readonly HiddenAttributes[]): boolean;
  blockedByModal(chain: readonly ModalState[], openModals: number): boolean;
  ariaModalDialog(node: AriaModalAttributes): boolean;
}

/**
 * Builds the resolver. This is the one definition of what counts as live, for the rule and for the
 * announcement capture in src/deps/real.ts. The capture runs in the browser, so it carries this
 * function into the page as its own source. That is why the function closes over nothing: every
 * table and helper it needs is defined inside it, so its source is the whole of it. A second copy
 * of these rules in the capture could drift, and a capture that hears a region the rule calls off
 * would let a flow requirement pass on an announcement no screen reader spoke.
 */
export function createLiveResolver(): LiveResolver {
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

  /**
   * The first recognized role in a role attribute, or null when it names none. Tokens match without
   * regard to ASCII case, as Chromium matches them. See the module comment for why.
   */
  function firstRecognizedRole(role: string | null): string | null {
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
  function ownLiveValue(node: LiveAttributes): LiveValue | null {
    if (node.ariaLive !== null && node.ariaLive !== '') {
      // Exact match, no case folding and no trimming. See the module comment.
      return node.ariaLive === 'polite' || node.ariaLive === 'assertive' ? node.ariaLive : 'off';
    }
    const role = firstRecognizedRole(node.role);
    return role === null ? null : (IMPLICIT_LIVE[role] ?? null);
  }

  /**
   * The index of the nearest element in a chain that sets a live value, or -1 when none does. The
   * chain is nearest first: the element itself, then its parent, and so on to the root.
   */
  function nearestLiveSetter(chain: readonly LiveAttributes[]): number {
    for (let index = 0; index < chain.length; index += 1) {
      if (ownLiveValue(chain[index] as LiveAttributes) !== null) {
        return index;
      }
    }
    return -1;
  }

  /**
   * The effective live value for a chain of elements, nearest first: the element itself, then its
   * parent, and so on to the root. An empty chain is off.
   */
  function effectiveLiveValue(chain: readonly LiveAttributes[]): LiveValue {
    const index = nearestLiveSetter(chain);
    return index < 0 ? 'off' : (ownLiveValue(chain[index] as LiveAttributes) ?? 'off');
  }

  // aria-hidden values that leave an element exposed. Chromium 151 hides an element for every other
  // non-empty value, "true" and "banana" and " false" alike, and matches these two without regard to
  // ASCII case. Reading any other value as hidden matches the browser.
  const ARIA_HIDDEN_SHOWN: ReadonlySet<string> = new Set(['false', 'undefined']);

  /**
   * True when any element in a chain hides its subtree from assistive technology: an aria-hidden
   * value the browser reads as true, an inert attribute, a hidden attribute, or a dialog element
   * that is closed. Content inside such an element is silent even inside a live region.
   * aria-hidden="false" does not bring back content an ancestor hides, so one hiding element
   * anywhere in the chain is enough. A hidden attribute or a closed dialog that page CSS shows is
   * still read as hidden. That can only make the capture hear less.
   */
  function hiddenInChain(chain: readonly HiddenAttributes[]): boolean {
    return chain.some(
      (node) =>
        node.inert ||
        node.hidden ||
        node.closedDialog ||
        (node.ariaHidden !== null && node.ariaHidden !== '' && !ARIA_HIDDEN_SHOWN.has(asciiLower(node.ariaHidden))),
    );
  }

  /**
   * True when a modal dialog is open and the chain is not inside every open one. While a dialog
   * opened with showModal() is open, Chromium leaves everything outside the top one out of the
   * accessibility tree, so a screen reader says nothing for a live region there. Which open modal
   * is on top is not in the DOM, so content must sit inside all of them to count. The top one is
   * always among them, so this hides at least what the browser hides. Content in a lower modal
   * that the top one is nested in is hidden here and by the browser alike. The chain is the
   * element and the elements above it in the flat tree, each listed once, and openModals counts
   * the open modal dialogs in the document.
   */
  function blockedByModal(chain: readonly ModalState[], openModals: number): boolean {
    if (openModals <= 0) {
      return false;
    }
    return chain.filter((node) => node.modal).length < openModals;
  }

  /**
   * Whether an element's attributes make it an ARIA modal dialog, as Chromium's AXObject::IsModal
   * reads them: the first recognized role is dialog or alertdialog, and aria-modal is true. Chromium
   * reads an ARIA boolean as true for any value but empty, "undefined", or "false", without regard
   * to ASCII case. Whether the dialog is shown is read in the browser, not here.
   */
  function ariaModalDialog(node: AriaModalAttributes): boolean {
    const role = firstRecognizedRole(node.role);
    if (role !== 'dialog' && role !== 'alertdialog') {
      return false;
    }
    const value = node.ariaModal === null ? '' : asciiLower(node.ariaModal);
    return value !== '' && value !== 'undefined' && value !== 'false';
  }

  return { firstRecognizedRole, ownLiveValue, nearestLiveSetter, effectiveLiveValue, hiddenInChain, blockedByModal, ariaModalDialog };
}

const resolver = createLiveResolver();

/**
 * The first recognized role in a role attribute, or null when it names none. Tokens match without
 * regard to ASCII case, as Chromium matches them. See the module comment for why.
 */
export const firstRecognizedRole = resolver.firstRecognizedRole;

/** The live value this one element sets, or null when it sets none and its ancestors decide. */
export const ownLiveValue = resolver.ownLiveValue;

/**
 * The effective live value for a chain of elements, nearest first: the element itself, then its
 * parent, and so on to the root. An empty chain is off.
 */
export const effectiveLiveValue = resolver.effectiveLiveValue;

/**
 * Whether anything in a chain of elements hides its subtree from assistive technology, by the same
 * rule the announcement capture applies. See the resolver for the aria-hidden values that count.
 */
export const hiddenInChain = resolver.hiddenInChain;

/** Whether an element's role and aria-modal attributes make it an ARIA modal dialog. */
export const ariaModalDialog = resolver.ariaModalDialog;
