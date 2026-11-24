/**
 * Static toast containment check for PatternFly alerts.
 * This unit must never claim the temporal announcement half. It only proves containment.
 */
import type { AncestorAttributesRead, AxNode, CoverageGap, Draft, ProviderContext } from '../../contracts/index.js';
import {
  ariaModalDialog,
  effectiveLiveValue,
  hiddenInChain,
  nearestLiveSetter,
  type HiddenAttributes,
  type LiveAttributes,
} from './live-value.js';
import { SEL } from './selectors.js';

// class is read only to tell a PatternFly toast group from other content. It is matched, never
// copied into a draft.
const LIVE_ATTRIBUTES = ['aria-live', 'role', 'aria-hidden', 'inert', 'hidden', 'class'] as const;

// The class tokens of a PatternFly 6 toast group. An element is one when it carries both, in any
// order. PatternFly renders the group as a list inside a plain div that it adds to the body. The
// list is live only when the app sets it live, with isLiveRegion.
const TOAST_GROUP_CLASS = 'pf-v6-c-alert-group pf-m-toast';
const CLASS_SEPARATOR = /[\t\n\f\r ]+/;

function isToastGroup(record: Record<string, string | null>): boolean {
  const tokens = new Set((record['class'] ?? '').split(CLASS_SEPARATOR));
  return TOAST_GROUP_CLASS.split(' ').every((token) => tokens.has(token));
}

// The same toast group as a selector, built from the same class tokens.
const TOAST_GROUP_SELECTOR = TOAST_GROUP_CLASS.split(' ')
  .map((token) => `[class~="${token}"]`)
  .join('');

function toLiveAttributes(record: Record<string, string | null>): LiveAttributes {
  return { ariaLive: record['aria-live'] ?? null, role: record['role'] ?? null };
}

// The hidden facts the ancestor read can give. The read returns attributes and not the tag name, so
// a closed dialog element is not seen here. A missing fact can only let an alert pass that the
// capture would not hear, never flag one it would.
function toHiddenAttributes(record: Record<string, string | null>): HiddenAttributes {
  return {
    ariaHidden: record['aria-hidden'] ?? null,
    inert: (record['inert'] ?? null) !== null,
    hidden: (record['hidden'] ?? null) !== null,
    closedDialog: false,
  };
}

const GAP_REF = 'provider:pf-rulepack/pf-toast-live-region';

function checkGap(what: 'alert' | 'toast group', selector: string, why: string): CoverageGap {
  return {
    ref: GAP_REF,
    state: 'not-covered',
    reason: `rulepack check pf-toast-live-region could not check ${what} ${selector}: ${why}`,
  };
}

function alertGap(selector: string, why: string): CoverageGap {
  return checkGap('alert', selector, why);
}

export interface ToastLiveRegionResult {
  drafts: Draft[];
  // One gap per alert whose live value could not be resolved. Each names the alert, so an alert
  // that could not be checked is never read as one that passed, and it does not hide the others.
  gaps: CoverageGap[];
}

/**
 * Whether a modal dialog is open on the page and exposed to assistive technology: a dialog element
 * the browser reads as modal, or an element whose role and aria-modal make it a modal dialog. An
 * exposed modal is not under any element that hides its subtree, so it sits outside the element
 * that hides the page behind it.
 */
async function exposedModalOpen(ctx: ProviderContext): Promise<boolean> {
  for (const dialog of await ctx.page.queryAll('dialog:modal')) {
    if ((await ctx.page.axAt(dialog.selector)) !== null) {
      return true;
    }
  }
  for (const candidate of await ctx.page.queryAll('[aria-modal]')) {
    const role = await ctx.page.getAttribute(candidate.selector, 'role');
    const ariaModal = await ctx.page.getAttribute(candidate.selector, 'aria-modal');
    if (ariaModalDialog({ role, ariaModal }) && (await ctx.page.axAt(candidate.selector)) !== null) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the third entry from the top of an alert's chain is a child of the body. The ancestor read
 * gives attributes, not tag names, and the chain of an element in the document always ends at the
 * root element. So the entry below the root is the body only when the root holds one body and no
 * other child but the head, and the alert is not in the head.
 */
async function bodyChildKnown(ctx: ProviderContext): Promise<boolean> {
  const bodies = await ctx.page.queryAll(':root > body');
  const strays = await ctx.page.queryAll(':root > :not(head):not(body)');
  const inHead = await ctx.page.queryAll(`:root > head ${SEL.alert}`);
  return bodies.length === 1 && strays.length === 0 && inHead.length === 0;
}

// The alert sits in content hidden from assistive technology, and an open modal dialog is on the
// page, but the rule cannot tell whether the hidden element is the page's top-level container that
// the modal hides on purpose. So the alert is neither passed nor failed.
function behindModalDraft(ctx: ProviderContext, selector: string, node: AxNode | null): Draft {
  return {
    rule: 'pf-toast-live-region',
    layer: 'pf',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: ctx.screen.id,
    elementPath: selector,
    elementName: node?.name ?? null,
    role: node?.role ?? null,
    whatUserExperiences: 'Could not verify that assistive technology announces this alert.',
    why: 'The alert is inside content hidden from assistive technology while an open modal dialog is on the page. A modal dialog hides the page behind it on purpose, but usabl could not tell whether the hidden element is the page container the modal hides, so it could not check the alert.',
    fix: 'Check this screen in a state with no modal dialog open when the page loads, or check the alert by hand.',
    evidence: {
      name: { value: node?.name ?? null, source: 'ax-tree', fromTree: true },
      role: { value: node?.role ?? null, source: 'ax-tree', fromTree: true },
    },
    confidence: 'unverified',
  };
}

// The toast area itself is hidden by an open modal dialog: the body's child that the modal hides is
// the alert's live region or sits inside it, or it is or holds the toast group the alert sits in.
// While the dialog is open, a screen reader hears no toast. Whether a toast can appear while this
// dialog is open is not something the rule can read from the page, so the alert is neither passed
// nor failed. The same draft is given to an empty toast group the modal hides, because an alert
// shown in it while the dialog is open is not heard either.
function toastAreaBehindModalDraft(
  ctx: ProviderContext,
  selector: string,
  node: AxNode | null,
  subject: 'alert' | 'empty toast group',
): Draft {
  return {
    rule: 'pf-toast-live-region',
    layer: 'pf',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: ctx.screen.id,
    elementPath: selector,
    elementName: node?.name ?? null,
    role: node?.role ?? null,
    whatUserExperiences:
      subject === 'alert'
        ? 'While the open dialog is shown, a screen reader may not announce this alert.'
        : 'While the open dialog is shown, a screen reader may not announce an alert shown in this toast area.',
    why: 'An open dialog hides the toast area from screen readers, so an alert shown while the dialog is open may not be announced. usabl cannot tell whether alerts appear while this dialog is open.',
    fix: 'A person needs to check whether alerts can appear while this dialog is open. If they can, show those alerts where a screen reader can reach them while the dialog is open, for example inside the dialog.',
    evidence: {
      name: { value: node?.name ?? null, source: 'ax-tree', fromTree: true },
      role: { value: node?.role ?? null, source: 'ax-tree', fromTree: true },
    },
    confidence: 'unverified',
  };
}

// The page facts the modal case needs, each read at most once per check, and only when needed:
// whether a modal is open, and whether a chain can name the body's child.
interface ModalReads {
  modalOpen: boolean | null;
  bodyChild: boolean | null;
}

/**
 * How one element's chain, nearest first, is hidden from assistive technology. The alert path and
 * the empty toast group path both read it here, so they apply the same modal case.
 * - 'shown': nothing in the chain hides its subtree.
 * - 'hidden': something hides it, and it is not the modal case below.
 * - 'modal-unclear': one element hides it and an open modal is on the page, but the chain cannot
 *   name the body's child, so the rule cannot tell whether that element is the one the modal hides.
 * - 'behind-modal': the one element that hides it is the body's child, and an open modal dialog
 *   sits outside it. bodyChildIndex is that element's index in the chain.
 */
type ChainHiding =
  | { kind: 'shown' }
  | { kind: 'hidden' }
  | { kind: 'modal-unclear' }
  | { kind: 'behind-modal'; bodyChildIndex: number };

async function chainHiding(
  ctx: ProviderContext,
  chain: ReadonlyArray<Record<string, string | null>>,
  reads: ModalReads,
): Promise<ChainHiding> {
  const hiddenAt = chain.map((entry) => hiddenInChain([toHiddenAttributes(entry)]));
  const hiddenCount = hiddenAt.filter((entry) => entry).length;
  if (hiddenCount === 0) {
    return { kind: 'shown' };
  }
  if (hiddenCount > 1) {
    return { kind: 'hidden' };
  }
  reads.modalOpen ??= await exposedModalOpen(ctx);
  if (!reads.modalOpen) {
    return { kind: 'hidden' };
  }
  reads.bodyChild ??= await bodyChildKnown(ctx);
  if (!reads.bodyChild) {
    return { kind: 'modal-unclear' };
  }
  const onlyHidden = hiddenAt.indexOf(true);
  return onlyHidden === chain.length - 3 ? { kind: 'behind-modal', bodyChildIndex: onlyHidden } : { kind: 'hidden' };
}

/**
 * Empty toast groups that an open modal hides. PatternFly renders the toast group as soon as a
 * toast AlertGroup mounts, before any alert is in it, so a screen checked with a modal open often
 * has an empty group. The alert walk never reaches it. A group that holds an alert is left to the
 * alert walk, so it gets one draft, not two. A group that is shown, or hidden in another way, gets
 * nothing here.
 */
async function checkEmptyToastGroups(
  ctx: ProviderContext,
  reads: ModalReads,
  drafts: Draft[],
  gaps: CoverageGap[],
): Promise<void> {
  const groups = await ctx.page.queryAll(TOAST_GROUP_SELECTOR);
  if (groups.length === 0) {
    return;
  }
  // With no open modal, no group can be in the modal case, so nothing more is read.
  reads.modalOpen ??= await exposedModalOpen(ctx);
  if (!reads.modalOpen) {
    return;
  }
  for (const groupRef of groups) {
    if ((await ctx.page.queryAll(`${groupRef.selector} ${SEL.alert}`)).length > 0) {
      continue;
    }
    let read: AncestorAttributesRead;
    try {
      read = await ctx.page.ancestorAttributes(groupRef.selector, LIVE_ATTRIBUTES);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      gaps.push(checkGap('toast group', groupRef.selector, `its ancestors could not be read: ${message}`));
      continue;
    }
    if (read.kind === 'not-found') {
      gaps.push(checkGap('toast group', groupRef.selector, 'it could not be found again to read its ancestors'));
      continue;
    }
    if (read.kind === 'too-deep') {
      gaps.push(
        checkGap(
          'toast group',
          groupRef.selector,
          `it has more than ${read.limit} ancestors, so the walk stopped before it reached the root`,
        ),
      );
      continue;
    }
    // The group is a toast group, so when the modal hides the body's child above it, that child is
    // or holds the toast area.
    if ((await chainHiding(ctx, read.chain, reads)).kind === 'behind-modal') {
      drafts.push(
        toastAreaBehindModalDraft(ctx, groupRef.selector, await ctx.page.axAt(groupRef.selector), 'empty toast group'),
      );
    }
  }
}

export async function checkPfToastLiveRegion(ctx: ProviderContext): Promise<ToastLiveRegionResult> {
  const allAlerts = await ctx.page.queryAll(SEL.alert);
  const drafts: Draft[] = [];
  const gaps: CoverageGap[] = [];
  const reads: ModalReads = { modalOpen: null, bodyChild: null };

  for (const alertRef of allAlerts) {
    // A CSS selector can only ask whether some live container sits anywhere above the alert. The
    // live value that applies is the one on the nearest element that sets one, so an off wrapper
    // between a polite region and the alert silences it. That is resolved here, one alert at a time.
    let read: AncestorAttributesRead;
    try {
      read = await ctx.page.ancestorAttributes(alertRef.selector, LIVE_ATTRIBUTES);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      gaps.push(alertGap(alertRef.selector, `its ancestors could not be read: ${message}`));
      continue;
    }
    if (read.kind === 'not-found') {
      // The alert matched a moment ago and cannot be found now. PatternFly toasts close on a timer,
      // so this is expected. Passing it would be a guess, and so would dropping the other alerts.
      gaps.push(
        alertGap(alertRef.selector, 'it could not be found again to read its ancestors, so it may have closed'),
      );
      continue;
    }
    if (read.kind === 'too-deep') {
      gaps.push(
        alertGap(
          alertRef.selector,
          `it has more than ${read.limit} ancestors, so the walk stopped before it reached the root`,
        ),
      );
      continue;
    }
    if (read.chain.length === 0) {
      gaps.push(alertGap(alertRef.selector, 'the page returned no element for it'));
      continue;
    }
    const nodes = read.chain.map(toLiveAttributes);

    // Two conditions, both required. The container above the alert must be live, because a live
    // value the alert carries itself does not make a region that exists before the alert mounts.
    // And the alert's own content must be live, because an aria-live="off" on the alert itself
    // silences it even inside a live container.
    const containerIsLive = effectiveLiveValue(nodes.slice(1)) !== 'off';
    const contentIsLive = effectiveLiveValue(nodes) !== 'off';
    // A live region inside content hidden from assistive technology announces nothing, so the alert
    // or anything above it that hides its subtree silences it as surely as no live region does.
    // One case is the modal pattern working as intended. PatternFly hides the app root, a child of
    // the body, while a modal dialog it renders outside the root is open, and the live region works
    // again when the modal closes. When the only hidden element is the body's child and an open
    // modal sits outside it, the alert is judged by its live region alone, as when no modal is open.
    // The same modal also hides a toast group under the body. That is not page content the modal
    // means to hide, so it is reported below as undecided, never passed.
    const hiding = await chainHiding(ctx, read.chain, reads);
    if (hiding.kind === 'modal-unclear') {
      drafts.push(behindModalDraft(ctx, alertRef.selector, await ctx.page.axAt(alertRef.selector)));
      continue;
    }
    const hidden = hiding.kind === 'hidden';
    let toastAreaBehindModal = false;
    if (hiding.kind === 'behind-modal') {
      // The hidden body child is the toast area when it is the nearest live region above the
      // alert, or sits inside the one that is, or when it is or holds a toast group around the
      // alert.
      const liveSetter = nearestLiveSetter(nodes.slice(1));
      toastAreaBehindModal =
        (liveSetter !== -1 && liveSetter + 1 >= hiding.bodyChildIndex) ||
        read.chain.slice(0, hiding.bodyChildIndex + 1).some(isToastGroup);
    }
    if (containerIsLive && contentIsLive && !hidden) {
      if (toastAreaBehindModal) {
        drafts.push(
          toastAreaBehindModalDraft(ctx, alertRef.selector, await ctx.page.axAt(alertRef.selector), 'alert'),
        );
      }
      continue;
    }

    const node = await ctx.page.axAt(alertRef.selector);
    drafts.push({
      rule: 'pf-toast-live-region',
      layer: 'pf',
      severity: 'serious',
      evidenceClass: 'deterministic',
      screenId: ctx.screen.id,
      elementPath: alertRef.selector,
      elementName: node?.name ?? null,
      role: node?.role ?? null,
      whatUserExperiences: 'A toast appears but assistive technology may not announce it.',
      why: hidden
        ? 'The alert, or an element above it, is hidden from assistive technology by aria-hidden, inert, or hidden, so no live region announces it.'
        : 'No polite or assertive live region reaches the alert.',
      fix: hidden
        ? 'Remove aria-hidden, inert, or hidden from the alert and the elements above it.'
        : 'Render the alert inside a live region container that remains mounted.',
      evidence: {
        name: { value: node?.name ?? null, source: 'ax-tree', fromTree: true },
        role: { value: node?.role ?? null, source: 'ax-tree', fromTree: true },
      },
      confidence: 'fail',
    });
  }

  await checkEmptyToastGroups(ctx, reads, drafts, gaps);
  return { drafts, gaps };
}
