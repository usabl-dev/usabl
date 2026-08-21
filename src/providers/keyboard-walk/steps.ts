/**
 * Step runner for keyboard interaction transcripts.
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

export function makeConcreteStepRunner(): StepRunner {
  return {
    async run(page: Page, steps: Step[]): Promise<TranscriptStop[]> {
      await page.armAnnouncementCapture();
      const stops: TranscriptStop[] = [];

      for (const [index, step] of steps.entries()) {
        await executeStep(page, step);
        const elementPath = await page.activePath();
        const node = await page.activeNode();
        const liveText = await page.drainAnnouncements();
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

        stops.push({ index, elementPath, announcement });
      }

      return stops;
    },
  };
}

export function makeStepRunner(): StepRunner {
  return makeConcreteStepRunner();
}
