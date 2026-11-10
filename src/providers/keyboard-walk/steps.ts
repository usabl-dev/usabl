/**
 * Step runner for keyboard interaction transcripts and interaction contracts.
 * It must never silent-no-op unknown step kinds, and it must never skip live-token drains.
 * This keeps interaction evidence honest while the gate remains the only verdict authority.
 */
import type {
  AnnouncementDrain,
  AnnouncementSourcesDrain,
  AnnouncementToken,
  Page,
  Step,
  StepRunner,
  TranscriptStop,
} from '../../contracts/index.js';
import type { StepObserver } from '../../voicing/silent-change.js';

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
    case 'press': {
      // A press with no key would press nothing and read the window as if the key had been pressed.
      if (typeof step.key !== 'string' || step.key.trim().length === 0) {
        throw new Error('a press step needs a key');
      }
      await page.press(step.key);
      return;
    }
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
  // Reads around each step the runner drives, for a check that needs no contract of its own, such
  // as the silent change rule. It is told about every step, reads only, and never throws. With an
  // observer, each drain also says where each text came from, and the transcript reads only its
  // texts and its undecidable reason, the same as without one.
  observer?: StepObserver;
}

export function makeConcreteStepRunner(options: StepRunnerOptions = {}): StepRunner {
  const settle = options.settleAfterEachStep === true;
  const observer = options.observer;
  // The drain an observer reads carries the source of each text. Without one, the drain is the
  // one the runner has always taken.
  const drainRecord = async (page: Page): Promise<{ drain: AnnouncementDrain; sourced: AnnouncementSourcesDrain | null }> => {
    if (observer === undefined) {
      return { drain: await page.drainAnnouncementRecord(), sourced: null };
    }
    const sourced = await page.drainAnnouncementSources();
    return { drain: sourced, sourced };
  };
  return {
    async run(page: Page, steps: Step[]): Promise<TranscriptStop[]> {
      await page.armAnnouncementCapture();
      if (settle) {
        // The capture runs for the life of the page, so it still holds what earlier checks caused,
        // such as a flow requirement that clicked and never drained. Left in, it would land in the
        // first window and could satisfy an obligation this contract's steps never caused.
        const earlier = await drainRecord(page);
        observer?.start(earlier.sourced);
      }
      const stops: TranscriptStop[] = [];

      for (const [index, step] of steps.entries()) {
        await observer?.before(page, step, index);
        let stop: TranscriptStop;
        try {
          stop = await runOneStep(page, step, index);
        } catch (error) {
          observer?.threw(step, index, error);
          throw error;
        }
        stops.push(stop);
      }

      return stops;
    },
  };

  async function runOneStep(page: Page, step: Step, index: number): Promise<TranscriptStop> {
    await executeStep(page, step);
    const settled = settle ? await page.settleAfterAction() : null;
    const elementPath = await page.activePath();
    const node = await page.activeNode();
    const focusUnreadable = await page.activeFocusUnreadable();
    const onBody = await page.activeElementIs('body');
    const { drain, sourced } = settle ? await drainRecord(page) : { drain: { texts: await page.drainAnnouncements(), undecidable: null }, sourced: null };
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
    if (onBody) {
      stop.onBody = true;
    }
    if (settled !== null && !settled.settled) {
      stop.unsettled = { waitedMs: settled.waitedMs };
    }
    if (drain.undecidable !== null) {
      stop.drainUndecidable = drain.undecidable;
    }
    await observer?.after(page, step, index, { settle: settled, drain: sourced });
    return stop;
  }
}

export function makeStepRunner(options: StepRunnerOptions = {}): StepRunner {
  return makeConcreteStepRunner(options);
}
