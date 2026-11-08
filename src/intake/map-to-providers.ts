/**
 * Maps authored intake requirements to deterministic runtime Providers.
 * Intake drafts are direct observations against authored strings and actions, but they still
 * never mint a verdict because the gate remains the only verdict authority.
 * Documentation requirements emit no Provider because they define output artifacts, not checks.
 */
import type {
  AnnouncementUndecidable,
  AxNode,
  ContentAssertion,
  Draft,
  FlowAssertion,
  FocusUnreadable,
  Page,
  PlannedApplicability,
  Provider,
  Requirement,
  RequirementBundle,
  Step,
} from '../contracts/index.js';
import { FOCUS_UNREADABLE_FIX, focusUnreadableCause } from '../primitives/focus-unreadable.js';

function hasNonEmptyName(name: string | null): boolean {
  return name !== null && name.trim().length > 0;
}

function trimEqual(actual: string | null, expected: string): boolean {
  if (actual === null) {
    return false;
  }
  return actual.trim() === expected.trim();
}

function evidenceFromNode(node: AxNode | null, extra: Record<string, unknown> = {}): Draft['evidence'] {
  const evidence: Draft['evidence'] = {};
  if (node !== null) {
    evidence.name = { value: node.name, source: 'ax-tree', fromTree: true };
    evidence.role = { value: node.role, source: 'ax-tree', fromTree: true };
  }
  if (Object.keys(extra).length > 0) {
    evidence.extra = extra;
  }
  return evidence;
}

function contentFailureDraft(
  requirement: Requirement,
  assertion: ContentAssertion,
  node: AxNode | null,
  whatUserExperiences: string,
  why: string,
  fix: string,
): Draft {
  return {
    rule: `intake:${requirement.id}`,
    layer: 'intake-content',
    severity: 'moderate',
    evidenceClass: 'deterministic',
    screenId: requirement.surface,
    elementPath: assertion.selector,
    elementName: node?.name ?? null,
    role: node?.role ?? null,
    whatUserExperiences,
    why,
    fix,
    evidence: evidenceFromNode(node),
    confidence: 'fail',
  };
}

function flowFailureDraft(
  requirement: Requirement,
  node: AxNode | null,
  elementPath: string,
  expectedAnnouncement: string,
  announcements: string[],
): Draft {
  return {
    rule: `intake:${requirement.id}`,
    layer: 'intake-flow',
    severity: 'moderate',
    evidenceClass: 'deterministic',
    screenId: requirement.surface,
    elementPath,
    elementName: node?.name ?? null,
    role: node?.role ?? null,
    whatUserExperiences: `Expected announcement was not heard: "${expectedAnnouncement}".`,
    why: 'Authored interaction text was not observed on focus or live-region announcements.',
    fix: 'Update focus behavior or live-region messaging so the expected announcement is emitted.',
    evidence: evidenceFromNode(node, {
      expectedAnnouncement,
      announcements,
    }),
    confidence: 'fail',
  };
}

// The expected text was not heard in an announcement, and the focused control could not be read,
// so whether its name matches is unknown. That is a gap, never a fail.
function flowUnreadableDraft(
  requirement: Requirement,
  elementPath: string,
  expectedAnnouncement: string,
  announcements: string[],
  reason: FocusUnreadable,
): Draft {
  return {
    rule: `intake:${requirement.id}`,
    layer: 'intake-flow',
    severity: 'moderate',
    evidenceClass: 'deterministic',
    screenId: requirement.surface,
    elementPath,
    elementName: null,
    role: null,
    whatUserExperiences: `Whether users hear "${expectedAnnouncement}" is unknown: it was not in a live-region announcement, and the focused control could not be read.`,
    why: `The expected text may be the focused control's name, but ${focusUnreadableCause(reason)}.`,
    fix: FOCUS_UNREADABLE_FIX,
    evidence: evidenceFromNode(null, { expectedAnnouncement, announcements, focusUnreadable: reason }),
    confidence: 'unverified',
  };
}

const UNDECIDABLE_CAUSE: Record<AnnouncementUndecidable, string> = {
  'closed-shadow-modal':
    'a modal dialog is open inside a closed shadow root, so usabl cannot tell which live regions it hides from assistive technology',
  'changed-element-removed':
    'a modal dialog is open, and a live region that changed was removed before usabl could check whether the modal hid it',
};

// The drain cannot say which announcements a screen reader heard, so the flow is neither a pass
// nor a fail. It is a gap that names the cause.
function flowUndecidableDraft(
  requirement: Requirement,
  node: AxNode | null,
  elementPath: string,
  expectedAnnouncement: string,
  announcements: string[],
  reason: AnnouncementUndecidable,
): Draft {
  return {
    rule: `intake:${requirement.id}`,
    layer: 'intake-flow',
    severity: 'moderate',
    evidenceClass: 'deterministic',
    screenId: requirement.surface,
    elementPath,
    elementName: node?.name ?? null,
    role: node?.role ?? null,
    whatUserExperiences: `Whether users hear "${expectedAnnouncement}" is unknown.`,
    why: `usabl cannot tell which live-region announcements a screen reader spoke: ${UNDECIDABLE_CAUSE[reason]}.`,
    fix: 'Check this announcement by hand. To let usabl check it, keep modal dialogs out of closed shadow roots, and keep the live region in the document until the step ends.',
    evidence: evidenceFromNode(node, { expectedAnnouncement, announcements, undecidable: reason }),
    confidence: 'unverified',
  };
}

async function runFlowStep(page: Page, step: Step): Promise<void> {
  if (step.do === 'tab') {
    await page.tab();
    return;
  }

  if (step.do === 'activate') {
    await page.press('Enter');
    return;
  }

  if (step.do === 'click' && typeof step.selector === 'string') {
    await page.click(step.selector);
    return;
  }

  if (step.do === 'press' && typeof step.key === 'string') {
    await page.press(step.key);
  }
}

// The one rule for which screen a requirement checks. Both runs below read it, so a brief that says
// a requirement is off on a screen cannot disagree with what the scan does there.
function requirementPlan(requirement: Requirement, screenId: string): PlannedApplicability {
  return screenId === requirement.surface
    ? { applies: true }
    : { applies: false, why: 'the requirement names another screen' };
}

function toContentProvider(requirement: Requirement, assertion: ContentAssertion): Provider {
  return {
    id: `intake:${requirement.id}`,
    layer: 'intake-content',
    capabilities: ['live'],
    appliesBeforeScan: (screen) => requirementPlan(requirement, screen.id),
    async run(ctx) {
      // Wrong surface is out of scope for this scan. Coverage wiring decides this later.
      if (!requirementPlan(requirement, ctx.screen.id).applies) {
        return [];
      }

      const node = await ctx.page.axAt(assertion.selector);

      if (assertion.expectedText !== undefined) {
        if (node === null) {
          return [
            contentFailureDraft(
              requirement,
              assertion,
              null,
              `Expected "${assertion.expectedText}" at ${assertion.selector}, but no accessible node was found.`,
              'The authored selector did not resolve to an accessible node for this screen.',
              'Ensure the selector identifies the intended element and the element is in the accessibility tree.',
            ),
          ];
        }

        if (node.name !== assertion.expectedText) {
          return [
            contentFailureDraft(
              requirement,
              assertion,
              node,
              `Expected "${assertion.expectedText}" at ${assertion.selector}, heard "${node.name ?? ''}".`,
              'Accessible text does not match the authored expectation.',
              'Update the accessible name or authored requirement text so they match.',
            ),
          ];
        }
      }

      if (assertion.mustNotBe === 'empty' && !hasNonEmptyName(node?.name ?? null)) {
        return [
          contentFailureDraft(
            requirement,
            assertion,
            node,
            `Expected a non-empty accessible name at ${assertion.selector}, but the name was empty.`,
            'Users would not hear usable text for this element.',
            'Provide meaningful accessible text for the element.',
          ),
        ];
      }

      // Decorative is only observable one-way here. We can fail when a name is present,
      // but absence of a name is not enough to prove decorative intent.
      if (assertion.mustNotBe === 'decorative' && hasNonEmptyName(node?.name ?? null)) {
        return [
          contentFailureDraft(
            requirement,
            assertion,
            node,
            `Element at ${assertion.selector} was marked decorative but announced "${node?.name ?? ''}".`,
            'Decorative content should not expose an accessible name.',
            'Remove the exposed accessible name or update the requirement if this is meaningful content.',
          ),
        ];
      }

      return [];
    },
  };
}

function toFlowProvider(requirement: Requirement, assertion: FlowAssertion): Provider {
  return {
    id: `intake:${requirement.id}`,
    layer: 'intake-flow',
    capabilities: ['live'],
    appliesBeforeScan: (screen) => requirementPlan(requirement, screen.id),
    async run(ctx) {
      // Wrong surface is out of scope for this scan. Coverage wiring decides this later.
      if (!requirementPlan(requirement, ctx.screen.id).applies) {
        return [];
      }

      await ctx.page.armAnnouncementCapture();
      for (const step of assertion.steps) {
        await runFlowStep(ctx.page, step);
      }

      if (assertion.expectedAnnouncement === undefined) {
        return [];
      }
      const expectedAnnouncement = assertion.expectedAnnouncement;

      const node = await ctx.page.activeNode();
      const drain = await ctx.page.drainAnnouncementRecord();
      const announcements = drain.texts;
      const heardOnFocus = trimEqual(node?.name ?? null, expectedAnnouncement);
      if (heardOnFocus) {
        return [];
      }
      // The focused control's name does not depend on the drain. Past this point the answer does,
      // so a drain that cannot say what was heard decides nothing, either way.
      if (drain.undecidable !== null) {
        return [
          flowUndecidableDraft(requirement, node, await ctx.page.activePath(), expectedAnnouncement, announcements, drain.undecidable),
        ];
      }
      const heardInAnnouncements = announcements.some((announcement) =>
        trimEqual(announcement, expectedAnnouncement),
      );

      if (heardInAnnouncements) {
        return [];
      }

      const unreadable = await ctx.page.activeFocusUnreadable();
      if (unreadable !== null) {
        return [flowUnreadableDraft(requirement, await ctx.page.activePath(), expectedAnnouncement, announcements, unreadable)];
      }

      return [
        flowFailureDraft(
          requirement,
          node,
          await ctx.page.activePath(),
          expectedAnnouncement,
          announcements,
        ),
      ];
    },
  };
}

export function mapRequirementsToProviders(bundle: RequirementBundle): Provider[] {
  const providers: Provider[] = [];

  for (const requirement of bundle.requirements) {
    if (requirement.assertion.type === 'content') {
      providers.push(toContentProvider(requirement, requirement.assertion));
      continue;
    }

    if (requirement.assertion.type === 'flow') {
      providers.push(toFlowProvider(requirement, requirement.assertion));
    }
  }

  return providers;
}
