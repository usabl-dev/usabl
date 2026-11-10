/**
 * Interaction probes for PatternFly dialog and menu focus behavior.
 * This unit emits Drafts only. It must never mint a verdict, and it must never treat a dead click as coverage.
 * Focus checks stay inside Page predicates so selector strings are never compared to DOM path strings.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { AxNode, Draft, ElementRef, ProviderContext } from '../../contracts/index.js';
import { SEL } from './selectors.js';

const FOCUS_SETTLE_TIMEOUT_MS = 2_500;
const FOCUS_POLL_INTERVAL_MS = 25;

function evidenceFromNode(node: AxNode | null): Draft['evidence'] {
  if (node === null) {
    return {};
  }

  return {
    name: { value: node.name, source: 'ax-tree', fromTree: true },
    role: { value: node.role, source: 'ax-tree', fromTree: true },
  };
}

function draft(
  ctx: ProviderContext,
  node: AxNode | null,
  rule: string,
  elementPath: string,
  confidence: Draft['confidence'],
  whatUserExperiences: string,
  why: string,
  fix: string,
): Draft {
  return {
    rule,
    layer: 'pf',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: ctx.screen.id,
    elementPath,
    elementName: node?.name ?? null,
    role: node?.role ?? null,
    whatUserExperiences,
    why,
    fix,
    evidence: evidenceFromNode(node),
    confidence,
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = FOCUS_SETTLE_TIMEOUT_MS): Promise<boolean> {
  // PatternFly can move focus into dialogs after paint, so a single sync check can race.
  // Polling up to the settle timeout still fails closed when focus never reaches the target.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) {
      return true;
    }
    await delay(FOCUS_POLL_INTERVAL_MS);
  }
  return false;
}

export async function probeDialogs(ctx: ProviderContext): Promise<Draft[]> {
  const triggers = await ctx.page.queryAll(SEL.dialogTrigger);
  const drafts: Draft[] = [];

  for (const trigger of triggers) {
    try {
      const triggerNode = await ctx.page.axAt(trigger.selector);
      // SEL.dialogTrigger has two arms and they mean different things when no dialog opens.
      // aria-haspopup="dialog" is a promise, so a dialog that never appears is a broken promise.
      // A plain disclosure control is only a candidate for being a dialog trigger, so it
      // showing something that is not a dialog says nothing about the page and is not reported.
      const declaresDialog = (await ctx.page.getAttribute(trigger.selector, 'aria-haspopup')) === 'dialog';
      await ctx.page.click(trigger.selector);

      const dialogAppeared = await waitFor(async () => (await ctx.page.queryAll(SEL.dialog)).length > 0);
      if (!dialogAppeared) {
        if (!declaresDialog) {
          continue;
        }
        drafts.push(
          draft(
            ctx,
            triggerNode,
            'pf-focus-into-dialog',
            trigger.selector,
            'unverified',
            'Could not verify dialog focus behavior.',
            'The trigger declares aria-haspopup="dialog" but no dialog appeared when activated; the probe could not establish the fact.',
            'Confirm the trigger opens a dialog, or remove aria-haspopup="dialog".',
          ),
        );
        continue;
      }

      const focusEnteredDialog = await waitFor(() => ctx.page.activeElementWithin(SEL.dialog));
      if (!focusEnteredDialog) {
        drafts.push(
          draft(
            ctx,
            triggerNode,
            'pf-focus-into-dialog',
            trigger.selector,
            'fail',
            'Focus does not move into the dialog when it opens; keyboard users remain behind the backdrop.',
            'The ARIA dialog pattern requires focus to move to the dialog or its first focusable element on open.',
            'Move focus to the PatternFly <Modal> initial focus target on render.',
          ),
        );
      }

      await ctx.page.press('Escape');
      // We fail closed on close-lifecycle checks when open-lifecycle focus never established.
      // A modal that never receives focus cannot honestly prove that close restores context.
      if (!focusEnteredDialog) {
        drafts.push(
          draft(
            ctx,
            triggerNode,
            'pf-modal-focus-return',
            trigger.selector,
            'fail',
            'The dialog focus lifecycle is broken, so focus return on close is not reliable for keyboard users.',
            'Focus never moved into the dialog, which means close behavior cannot restore a well-defined keyboard position.',
            "Move focus into the modal on open, then call .focus() on the trigger in the modal's onClose handler.",
          ),
        );
        continue;
      }

      if (!(await waitFor(() => ctx.page.activeElementIs(trigger.selector)))) {
        drafts.push(
          draft(
            ctx,
            triggerNode,
            'pf-modal-focus-return',
            trigger.selector,
            'fail',
            'After closing the dialog, focus is lost instead of returning to the button that opened it.',
            'WCAG 2.4.3: focus must return to the triggering element on dialog close, or screen-reader users lose their place.',
            "Call .focus() on the trigger in the modal's onClose handler.",
          ),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      drafts.push(
        draft(
          ctx,
          null,
          'pf-modal-focus-return',
          trigger.selector,
          'unverified',
          'Could not verify dialog focus behavior.',
          `The dialog probe failed: ${message}`,
          'Verify the dialog opens and closes cleanly, then re-run.',
        ),
      );
    }
  }

  return drafts;
}

/**
 * Whether a menu is open on the page for an expanded toggle: the element its aria-controls names is
 * exposed to assistive technology, or any menu on the page is. A menu that stays in the page while
 * it is closed is hidden from assistive technology, so it does not count.
 */
async function menuOpenFor(ctx: ProviderContext, toggle: ElementRef): Promise<boolean> {
  const controls = (await ctx.page.getAttribute(toggle.selector, 'aria-controls')) ?? '';
  for (const id of controls.split(/\s+/).filter((token) => token.length > 0)) {
    // An attribute selector with the id quoted, so an id with any character still names one element.
    const selector = `[id="${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    if ((await ctx.page.axAt(selector)) !== null) {
      return true;
    }
  }
  for (const menu of await ctx.page.queryAll(SEL.menu)) {
    if ((await ctx.page.axAt(menu.selector)) !== null) {
      return true;
    }
  }
  return false;
}

export async function probeMenus(ctx: ProviderContext): Promise<Draft[]> {
  const toggles = await ctx.page.queryAll(SEL.menuToggle);
  const drafts: Draft[] = [];

  for (const toggle of toggles) {
    try {
      const toggleNode = await ctx.page.axAt(toggle.selector);
      // A toggle whose menu is already open closes it on the click, so the click would show no new
      // menu and read as a promise broken. Its menu is left as it is. A toggle that says it is
      // expanded while no menu is open reports a state that is not true, which is itself an
      // accessibility barrier the probe cannot judge, so it says so instead of skipping in silence.
      if ((await ctx.page.getAttribute(toggle.selector, 'aria-expanded')) === 'true') {
        if (!(await menuOpenFor(ctx, toggle))) {
          drafts.push(
            draft(
              ctx,
              toggleNode,
              'pf-kebab-expanded-state',
              toggle.selector,
              'unverified',
              'Could not verify menu focus behavior.',
              'The toggle reports aria-expanded="true", but no menu is open on the page, so the probe could not check where focus goes.',
              'Set aria-expanded to "true" only while the menu is open, and to "false" when it closes.',
            ),
          );
        }
        continue;
      }
      // aria-haspopup="menu", and "true", its legacy synonym, promise a menu. A PatternFly
      // MenuToggle found by its OUIA type promises nothing by markup alone.
      const haspopup = await ctx.page.getAttribute(toggle.selector, 'aria-haspopup');
      const declaresMenu = haspopup === 'menu' || haspopup === 'true';
      // Record the menus already open before this toggle acts. The menu this toggle opens is one
      // that appears now but was not present before the click. Scoping the focus check to those,
      // rather than any [role=menu] on the page, fixes both directions: a stale menu sitting ahead
      // in query order no longer causes a false fail, and focus resting in an unrelated already-open
      // menu no longer counts as this toggle's success (a false pass).
      //
      // A menu can also stay in the page while it is closed, hidden from assistive technology, as a
      // menu toggled with the hidden attribute is. The click exposes it rather than adding it, so a
      // menu hidden before the click and exposed after it counts as opened too.
      const before = await ctx.page.queryAll(SEL.menu);
      const menusBefore = new Set(before.map((menu) => menu.selector));
      const hiddenBefore: ElementRef[] = [];
      for (const menu of before) {
        if ((await ctx.page.axAt(menu.selector)) === null) {
          hiddenBefore.push(menu);
        }
      }
      await ctx.page.click(toggle.selector);

      // A menu can mount a moment after the click, so wait for it the way the dialog probe waits
      // for its dialog. Read once at once, a late menu was missed with no draft.
      let openedMenus: ElementRef[] = [];
      await waitFor(async () => {
        openedMenus = (await ctx.page.queryAll(SEL.menu)).filter((menu) => !menusBefore.has(menu.selector));
        for (const menu of hiddenBefore) {
          if ((await ctx.page.axAt(menu.selector)) !== null) {
            openedMenus.push(menu);
          }
        }
        return openedMenus.length > 0;
      });
      if (openedMenus.length === 0) {
        await ctx.page.press('Escape');
        // A toggle that promised a menu and opened none is a promise the probe could not check.
        // Any other toggle opened something that is not a menu, which says nothing about it.
        if (declaresMenu) {
          drafts.push(
            draft(
              ctx,
              toggleNode,
              'pf-kebab-expanded-state',
              toggle.selector,
              'unverified',
              'Could not verify menu focus behavior.',
              `The toggle declares aria-haspopup="${haspopup}" but no menu appeared when it was activated, so the probe could not check where focus goes.`,
              'Confirm the toggle opens a menu, or remove aria-haspopup from it.',
            ),
          );
        }
        continue;
      }

      // Focus can arrive a frame after the menu mounts, so poll, but only against the menu that
      // opened. A stale or unrelated menu is excluded, so its focus cannot pass for this toggle.
      const focusEnteredMenu = await waitFor(async () => {
        for (const menu of openedMenus) {
          if (await ctx.page.activeElementWithin(menu.selector)) {
            return true;
          }
        }
        return false;
      });

      if (!focusEnteredMenu) {
        drafts.push(
          draft(
            ctx,
            toggleNode,
            'pf-kebab-expanded-state',
            toggle.selector,
            'fail',
            'Opening this menu leaves keyboard focus behind; users cannot reach the menu items.',
            'The ARIA menu button pattern moves focus into the menu on open.',
            'Focus the first menu item when the PatternFly menu opens.',
          ),
        );
      }

      await ctx.page.press('Escape');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      drafts.push(
        draft(
          ctx,
          null,
          'pf-kebab-expanded-state',
          toggle.selector,
          'unverified',
          'Could not verify menu focus behavior.',
          `The menu probe failed: ${message}`,
          'Verify the menu opens and closes cleanly, then re-run.',
        ),
      );
    }
  }

  return drafts;
}
