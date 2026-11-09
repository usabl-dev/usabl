/**
 * Maps authored intake requirements to deterministic runtime Providers.
 * Intake drafts are direct observations against authored strings and actions, but they still
 * never mint a verdict because the gate remains the only verdict authority.
 * Documentation requirements emit no Provider because they define output artifacts, not checks.
 * Voice requirements become virtual screen reader providers, whose drafts are preview unless the
 * obligation class is promoted in config.
 */
import type {
  ActionSettle,
  AnnouncementDrain,
  AnnouncementSourcesDrain,
  AnnouncementUndecidable,
  AxNode,
  ContentAssertion,
  Draft,
  FlowAssertion,
  FocusUnreadable,
  InteractionContract,
  Page,
  PlannedApplicability,
  Provider,
  ProviderOutput,
  Requirement,
  RequirementBundle,
  Step,
  VoiceAssertion,
} from '../contracts/index.js';
import { ANNOUNCEMENT_UNDECIDABLE_FIX, announcementUndecidableCause } from '../primitives/announcement-undecidable.js';
import { FOCUS_UNREADABLE_FIX, focusUnreadableCause } from '../primitives/focus-unreadable.js';
import { ProviderRunFailed } from '../providers/index.js';
import { makeStepRunner } from '../providers/keyboard-walk/steps.js';
import { isActionStep, makeSilentChangeWatch, type SilentChangeWatch } from '../voicing/silent-change.js';
import { makeVirtualSrProvider } from '../voicing/virtual-sr-provider.js';

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
    why: `usabl cannot tell which live-region announcements a screen reader spoke: ${announcementUndecidableCause(reason)}.`,
    fix: ANNOUNCEMENT_UNDECIDABLE_FIX,
    evidence: evidenceFromNode(node, { expectedAnnouncement, announcements, undecidable: reason }),
    confidence: 'unverified',
  };
}

// Whether the flow driver runs a step. A kind it does not know, a click with no selector, and a
// press with no key are not run.
function flowRuns(step: Step): boolean {
  return (
    step.do === 'tab' ||
    step.do === 'activate' ||
    (step.do === 'click' && typeof step.selector === 'string') ||
    (step.do === 'press' && typeof step.key === 'string')
  );
}

// Runs one flow step. Returns false for a step the driver does not run, so the caller can report
// it rather than read the page as if the step had happened.
async function runFlowStep(page: Page, step: Step): Promise<boolean> {
  if (step.do === 'tab') {
    await page.tab();
    return true;
  }

  if (step.do === 'activate') {
    await page.press('Enter');
    return true;
  }

  if (step.do === 'click' && typeof step.selector === 'string') {
    await page.click(step.selector);
    return true;
  }

  if (step.do === 'press' && typeof step.key === 'string') {
    await page.press(step.key);
    return true;
  }
  return false;
}

// The drains of every step, read as the one drain the flow used to take after its last step: the
// texts in step order, and the first reason any of them could not be trusted.
function unionOfDrains(drains: readonly AnnouncementSourcesDrain[]): AnnouncementDrain {
  return {
    texts: drains.flatMap((drain) => drain.texts),
    undecidable: drains.find((drain) => drain.undecidable !== null)?.undecidable ?? null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The one rule for which screen a requirement checks. The content and flow runs read it, and the
// voice run skips a contract whose surfaceId is not the screen, which is the same test. So a brief
// that says a requirement is off on a screen cannot disagree with what the scan does there.
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
    // A flow clicks and presses keys, so it changes the page. Flagged, it runs after every provider
    // that reads the page as loaded, such as the PatternFly rulepack, which would otherwise check a
    // page where the flow had already removed or opened something.
    mutatesPageState: true,
    async run(ctx) {
      // Wrong surface is out of scope for this scan. Coverage wiring decides this later.
      if (!requirementPlan(requirement, ctx.screen.id).applies) {
        return [];
      }

      // The silent change rule watches each action step this loop drives. It only reads, never
      // throws, and never drives a step, so the flow runs exactly the steps it always ran.
      const watch = makeSilentChangeWatch();
      let drafts: Draft[];
      try {
        drafts = await runFlow(ctx.page, requirement, assertion, watch);
      } catch (error) {
        // The flow fails the way it always did, with the same message. The rule's drafts for the
        // steps that ran, and the gap for the step that threw, go with the failure.
        throw new ProviderRunFailed(errorMessage(error), watch.drafts(ctx.screen.id));
      }
      return [...drafts, ...watch.drafts(ctx.screen.id)];
    },
  };
}

async function runFlow(page: Page, requirement: Requirement, assertion: FlowAssertion, watch: SilentChangeWatch): Promise<Draft[]> {
  await page.armAnnouncementCapture();
  // Each step's drain is kept. The flow's verdict reads them all in step order, with the drain
  // taken before the first step leading, so it reads what the one drain after the last step read.
  // A drain that fails is kept as an error: the verdict needs every one, and fails with the first
  // failure, the way the one drain did. A flow with no expected announcement never needed one.
  const drains: AnnouncementSourcesDrain[] = [];
  const drainFailures: unknown[] = [];
  const takeDrain = async (): Promise<AnnouncementSourcesDrain | null> => {
    try {
      const drain = await page.drainAnnouncementSources();
      drains.push(drain);
      return drain;
    } catch (error) {
      drainFailures.push(error);
      return null;
    }
  };

  watch.start(await takeDrain());
  for (const [index, step] of assertion.steps.entries()) {
    const action = isActionStep(step) && flowRuns(step);
    if (action) {
      await watch.before(page, step, index);
    }
    let ran: boolean;
    try {
      ran = await runFlowStep(page, step);
    } catch (error) {
      watch.threw(step, index, error);
      throw error;
    }
    if (!ran) {
      watch.notRun(step, index);
      continue;
    }
    // An action step waits for the page to react before its window is read. A wait that fails
    // leaves the step unjudged by the rule and changes nothing for the flow.
    let settle: ActionSettle | null = null;
    if (action) {
      try {
        settle = await page.settleAfterAction();
      } catch {
        settle = null;
      }
    }
    const drain = await takeDrain();
    if (action) {
      await watch.after(page, step, index, { settle, drain });
    }
  }

  if (assertion.expectedAnnouncement === undefined) {
    return [];
  }
  const expectedAnnouncement = assertion.expectedAnnouncement;

  const node = await page.activeNode();
  if (drainFailures.length > 0) {
    throw drainFailures[0];
  }
  const drain = unionOfDrains(drains);
  const own = await flowVerdict(page, requirement, expectedAnnouncement, node, drain);
  // The flow's own draft already says whether its last step was heard. A second draft for that step
  // would be a second finding for one barrier, so the rule emits nothing for it.
  if (own.length > 0) {
    watch.quiet(assertion.steps.length - 1);
  }
  return own;
}

async function flowVerdict(
  page: Page,
  requirement: Requirement,
  expectedAnnouncement: string,
  node: AxNode | null,
  drain: AnnouncementDrain,
): Promise<Draft[]> {
  const announcements = drain.texts;
  const heardOnFocus = trimEqual(node?.name ?? null, expectedAnnouncement);
  if (heardOnFocus) {
    return [];
  }
  // The focused control's name does not depend on the drain. Past this point the answer does,
  // so a drain that cannot say what was heard decides nothing, either way.
  if (drain.undecidable !== null) {
    return [
      flowUndecidableDraft(requirement, node, await page.activePath(), expectedAnnouncement, announcements, drain.undecidable),
    ];
  }
  const heardInAnnouncements = announcements.some((announcement) =>
    trimEqual(announcement, expectedAnnouncement),
  );

  if (heardInAnnouncements) {
    return [];
  }

  const unreadable = await page.activeFocusUnreadable();
  if (unreadable !== null) {
    return [flowUnreadableDraft(requirement, await page.activePath(), expectedAnnouncement, announcements, unreadable)];
  }

  return [
    flowFailureDraft(
      requirement,
      node,
      await page.activePath(),
      expectedAnnouncement,
      announcements,
    ),
  ];
}

/** A requirement whose assertion is a voice assertion. */
export type VoiceRequirement = Requirement & { assertion: VoiceAssertion };

/**
 * The interaction contract a voice requirement describes. The requirement id names the contract,
 * so a draft or a gap can point back at the file a team wrote. The arrays are copied so a later
 * change to the bundle cannot change a contract that is already running.
 */
export function toVoiceContract(requirement: VoiceRequirement): InteractionContract {
  const contract: InteractionContract = {
    contractId: requirement.id,
    surfaceId: requirement.surface,
    task: requirement.description,
    steps: requirement.assertion.steps.map((step) => ({ ...step })),
    obligations: requirement.assertion.obligations.map((obligation) => ({
      ...obligation,
      requiredTokens: [...obligation.requiredTokens],
    })),
  };
  if (requirement.assertion.maxTabPath !== undefined) {
    contract.maxTabPath = requirement.assertion.maxTabPath;
  }
  return contract;
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

  // Voice contracts drive the page the way flow requirements do, so they run in the same group,
  // after every provider that reads the page as loaded, with the same flags. Each contract is
  // its own provider named by its requirement id, so a static-only run, or a contract whose step
  // fails, is a gap that names the requirement, and one failing contract does not hide another.
  for (const requirement of bundle.requirements) {
    if (requirement.assertion.type === 'voice') {
      const contract = toVoiceContract({ ...requirement, assertion: requirement.assertion });
      const options = { id: `intake:${requirement.id}`, rulePrefix: `intake:${requirement.id}` };
      providers.push({
        ...makeVirtualSrProvider([contract], makeStepRunner({ settleAfterEachStep: true }), options),
        appliesBeforeScan: (screen) => requirementPlan(requirement, screen.id),
        // The contract clicks and presses keys, so it changes the page, the same as a flow.
        mutatesPageState: true,
        // Each run gets its own silent change watch, which the step runner calls around each step
        // it drives. Its drafts keep the rule's own id, voicing/silent-change, because the rule is
        // not part of the contract.
        async run(ctx) {
          const watch = makeSilentChangeWatch();
          const provider = makeVirtualSrProvider([contract], makeStepRunner({ settleAfterEachStep: true, observer: watch }), options);
          let output: Draft[] | ProviderOutput;
          try {
            output = await provider.run(ctx);
          } catch (error) {
            throw new ProviderRunFailed(errorMessage(error), watch.drafts(ctx.screen.id));
          }
          const drafts = Array.isArray(output) ? output : output.drafts;
          return [...drafts, ...watch.drafts(ctx.screen.id)];
        },
      });
    }
  }

  return providers;
}
