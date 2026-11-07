/**
 * Step runner for keyboard interaction transcripts and interaction contracts.
 * It must never silent-no-op unknown step kinds, and it must never skip live-token drains.
 * This keeps interaction evidence honest while the gate remains the only verdict authority.
 */
import type {
  AnnouncementToken,
  Page,
  Step,
  StepRunner,
  TranscriptStop,
} from '../../contracts/index.js';

function tokenFromName(name: string): AnnouncementToken {
  return { kind: 'name', text: name, fromTree: true, source: 'ax-tree' };
}

function tokenFromRole(role: string): AnnouncementToken {
  return { kind: 'role', text: role, fromTree: true, source: 'ax-tree' };
}

function tokenFromState(state: string): AnnouncementToken {
  return { kind: 'state', text: state, fromTree: true, source: 'ax-tree' };
}

function tokenFromLive(text: string): AnnouncementToken {
  return { kind: 'live', text, fromTree: false, source: 'attribute' };
}

async function executeStep(page: Page, step: Step): Promise<void> {
  switch (step.do) {
    case 'tab':
      await page.tab();
      return;
    case 'press-escape':
      await page.press('Escape');
      return;
    case 'activate':
      await page.press('Enter');
      return;
    case 'click': {
      const selector = typeof step.selector === 'string' ? step.selector : '';
      await page.click(selector);
      return;
    }
    default:
      throw new Error(`unknown step kind: ${step.do}`);
  }
}

function stateTokens(states: Record<string, unknown>): AnnouncementToken[] {
  const tokens: AnnouncementToken[] = [];
  for (const [state, value] of Object.entries(states)) {
    if (value === true) {
      tokens.push(tokenFromState(state));
    }
  }
  return tokens;
}

export interface StepRunnerOptions {
  // Wait for the page to settle after each step before reading focus and draining, and drain with
  // the record that says when it cannot be trusted. Interaction contracts set this: an action such
  // as a delete often announces a moment after it runs, and draining at once would miss it, so the
  // transcript would depend on timing. The keyboard walk leaves it off. A Tab does not wait on the
  // application, and a settle wait of at least 1.5 seconds on each of up to 200 stops would spend
  // the walk's whole budget.
  settleAfterEachStep?: boolean;
}

export function makeConcreteStepRunner(options: StepRunnerOptions = {}): StepRunner {
  const settle = options.settleAfterEachStep === true;
  return {
    async run(page: Page, steps: Step[]): Promise<TranscriptStop[]> {
      await page.armAnnouncementCapture();
      if (settle) {
        // The capture runs for the life of the page, so it still holds what earlier checks caused,
        // such as a flow requirement that clicked and never drained. Left in, it would land in the
        // first window and could satisfy an obligation this contract's steps never caused.
        await page.drainAnnouncementRecord();
      }
      const stops: TranscriptStop[] = [];

      for (const [index, step] of steps.entries()) {
        await executeStep(page, step);
        const settled = settle ? await page.settleAfterAction() : null;
        const elementPath = await page.activePath();
        const node = await page.activeNode();
        const focusUnreadable = await page.activeFocusUnreadable();
        const drain = settle ? await page.drainAnnouncementRecord() : { texts: await page.drainAnnouncements(), undecidable: null };
        const liveText = drain.texts;
        const announcement: AnnouncementToken[] = [];

        if (node !== null) {
          if (node.name !== null) {
            announcement.push(tokenFromName(node.name));
          }
          if (node.role !== null) {
            announcement.push(tokenFromRole(node.role));
          }
          announcement.push(...stateTokens(node.states));
        }

        for (const text of liveText) {
          announcement.push(tokenFromLive(text));
        }

        const stop: TranscriptStop = { index, elementPath, announcement };
        if (focusUnreadable !== null) {
          stop.focusUnreadable = focusUnreadable;
        }
        if (settled !== null && !settled.settled) {
          stop.unsettled = { waitedMs: settled.waitedMs };
        }
        if (drain.undecidable !== null) {
          stop.drainUndecidable = drain.undecidable;
        }
        stops.push(stop);
      }

      return stops;
    },
  };
}

export function makeStepRunner(options: StepRunnerOptions = {}): StepRunner {
  return makeConcreteStepRunner(options);
}
