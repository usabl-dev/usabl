/**
 * Interaction probes for PatternFly dialog and menu focus behavior.
 * This unit emits Drafts only. It must never mint a verdict, and it must never treat a dead click as coverage.
 * Focus checks stay inside Page predicates so selector strings are never compared to DOM path strings.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { AxNode, Draft, ProviderContext } from '../../contracts/index.js';
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
      await ctx.page.click(trigger.selector);

      const dialogAppeared = await waitFor(async () => (await ctx.page.queryAll(SEL.dialog)).length > 0);
      if (!dialogAppeared) {
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

export async function probeMenus(ctx: ProviderContext): Promise<Draft[]> {
  const toggles = await ctx.page.queryAll(SEL.menuToggle);
  const drafts: Draft[] = [];

  for (const toggle of toggles) {
    try {
      const toggleNode = await ctx.page.axAt(toggle.selector);
      await ctx.page.click(toggle.selector);

      const menus = await ctx.page.queryAll(SEL.menu);
      const menu = menus[0];
      if (menu !== undefined && !(await waitFor(() => ctx.page.activeElementWithin(menu.selector)))) {
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
