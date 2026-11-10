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

// The expected text was announced only before the flow's first step, which the flow does not count,
// and its own steps did not announce it. An earlier check may have changed the page, such as by
// saving once already, so whether these steps announce it is unknown. That is a gap, never a fail.
function flowHeardBeforeDraft(
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
    whatUserExperiences: `Whether the flow's steps make users hear "${expectedAnnouncement}" is unknown.`,
    why: "The text was announced before the flow's first step, which the flow does not count, and its own steps did not announce it. An earlier check may have changed the page, so usabl cannot tell whether these steps announce it.",
    fix: 'Check this flow by hand with a screen reader, on the page as it first loads.',
    evidence: evidenceFromNode(node, { expectedAnnouncement, announcements, heardBeforeFirstStep: true }),
    confidence: 'unverified',
  };
}

// The focused control is named with the expected text, but focus did not change during the flow,
// or what had focus before it could not be read. Focus an earlier check left there is not evidence
// of anything the flow's steps did, so this is a gap, never a pass and never a fail.
function flowFocusUnchangedDraft(
  requirement: Requirement,
  node: AxNode | null,
  elementPath: string,
  expectedAnnouncement: string,
  announcements: string[],
  readBefore: boolean,
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
    whatUserExperiences: `Whether the flow's steps make users hear "${expectedAnnouncement}" is unknown.`,
    why: readBefore
      ? "The focused control is named with the expected text, but focus was already on that control before the flow ran, with the same name, and no step announced the text. Its name is not evidence of anything the flow's steps did."
      : "The focused control is named with the expected text, but what had focus could not be read before the flow ran, so usabl cannot tell whether the flow's steps moved focus there.",
    fix: 'Write the flow so its own steps move focus to that control or announce the text, or check this flow by hand with a screen reader.',
    evidence: evidenceFromNode(node, readBefore ? { expectedAnnouncement, announcements, focusUnchanged: true } : { expectedAnnouncement, announcements, focusBeforeUnreadable: true }),
    confidence: 'unverified',
  };
}

// What had focus: its DOM backend node id and its trimmed accessible name. Null when a read failed.
interface FocusMark {
  nodeId: number | null;
  name: string;
}

async function focusedNodeIdOrUnknown(page: Page): Promise<number | null | undefined> {
  try {
    return await page.focusedNodeId();
  } catch {
    return undefined;
  }
}

function focusMark(nodeId: number | null | undefined, node: AxNode | null): FocusMark | null {
  return nodeId === undefined ? null : { nodeId, name: node?.name?.trim() ?? '' };
}

async function readFocusMark(page: Page): Promise<FocusMark | null> {
  const nodeId = await focusedNodeIdOrUnknown(page);
  try {
    return focusMark(nodeId, await page.activeNode());
  } catch {
    return null;
  }
}

// Whether the flow's steps changed what has focus: another node, or the same node with another
// name. Unknown, when either read failed, is not a change.
function focusChanged(before: FocusMark | null, after: FocusMark | null): boolean {
  if (before === null || after === null) return false;
  return before.nodeId !== after.nodeId || before.name !== after.name;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// What a step lacks for the flow driver to run it, or null when it can run. A click needs a
// selector and a press needs a key; a missing, empty, or blank value is no value. An activate step
// presses Enter on the focused control and needs nothing more. Any other kind is not run.
function missingForFlow(step: Step): string | null {
  if (step.do === 'tab' || step.do === 'activate') {
    return null;
  }
  if (step.do === 'click') {
    return hasText(step.selector) ? null : "a click step needs a selector, such as selector: '#delete'";
  }
  if (step.do === 'press') {
    return hasText(step.key) ? null : 'a press step needs a key, such as key: Escape';
  }
  return 'the flow does not run this kind of step; write do as tab, activate, press with a key, or click with a selector';
}

// Runs one flow step the driver can run. The caller checked every step with missingForFlow first.
async function runFlowStep(page: Page, step: Step): Promise<void> {
  if (step.do === 'tab') {
    await page.tab();
  } else if (step.do === 'activate') {
    await page.press('Enter');
  } else if (step.do === 'click' && typeof step.selector === 'string') {
    await page.click(step.selector);
  } else if (step.do === 'press' && typeof step.key === 'string') {
    await page.press(step.key);
  } else {
    throw new Error(`the flow cannot run step kind ${step.do}`);
  }
}

// The drains taken after the flow's steps, read as one drain: the texts in step order, and the
// first reason any of them could not be trusted.
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
  // A step the driver cannot run would run as nothing, and the flow would judge a page its steps
  // never touched. So every step is checked before any runs. One that cannot run makes the flow a
  // not-covered gap that names it, and the silent change rule reports it as a step not run.
  const missing: string[] = [];
  for (const [index, step] of assertion.steps.entries()) {
    const lack = missingForFlow(step);
    if (lack !== null) {
      missing.push(`step ${index} (${step.do}): ${lack}`);
      watch.notRun(step, index);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `the flow ran none of its steps, because it cannot run ${missing.join('; ')}. Steps are counted from 0.`,
    );
  }

  await page.armAnnouncementCapture();
  // Each step's drain is kept. The flow's verdict reads them all in step order. A drain that fails
  // is kept as an error: the verdict needs every one, and fails with the first failure. A flow with
  // no expected announcement never needed one.
  const drains: AnnouncementSourcesDrain[] = [];
  // The step each kept drain was taken after, in the same order.
  const drainSteps: number[] = [];
  const drainFailures: unknown[] = [];
  const takeDrain = async (stepIndex: number | null): Promise<AnnouncementSourcesDrain | null> => {
    try {
      const drain = await page.drainAnnouncementSources();
      if (stepIndex !== null) {
        drains.push(drain);
        drainSteps.push(stepIndex);
      }
      return drain;
    } catch (error) {
      drainFailures.push(error);
      return null;
    }
  };

  // An earlier check can leave speech in flight, such as a status message that lands after its
  // click. So the flow first waits for the page to go quiet, with the same wait a click step uses,
  // and that speech lands before the drain below.
  let quiet: ActionSettle | null;
  try {
    quiet = await page.settleAfterAction();
  } catch {
    quiet = null;
  }
  // The capture runs for the life of the page, so the drain before the first step holds every
  // announcement since the last drain, such as one an earlier check caused. The verdict never
  // reads it: the flow is judged only on what was announced after its first step ran. The silent
  // change rule takes it as background speech. A failure of this drain still fails the flow,
  // because the speech it should have cleared could then land in the first step's drain.
  const drainBefore = await takeDrain(null);
  watch.start(drainBefore);
  // A page that did not go quiet may still speak for an earlier check during the first step. A flow
  // that judges speech cannot tell that speech from its own, so it runs none of its steps.
  if (assertion.expectedAnnouncement !== undefined && (quiet === null || !quiet.settled)) {
    throw new Error(
      quiet === null
        ? 'the wait for the page to go quiet before the flow failed, so speech an earlier check started could be counted as the flow\'s own. The flow ran none of its steps.'
        : 'the page did not go quiet before the flow started, so speech an earlier check started could be counted as the flow\'s own. The flow ran none of its steps.',
    );
  }
  // What had focus before the first step. The focused control's name counts as the flow's evidence
  // only when the flow's steps changed the focused node or its name.
  const focusBefore = assertion.expectedAnnouncement === undefined ? null : await readFocusMark(page);
  for (const [index, step] of assertion.steps.entries()) {
    const action = isActionStep(step);
    if (action) {
      await watch.before(page, step, index);
    }
    try {
      await runFlowStep(page, step);
    } catch (error) {
      watch.threw(step, index, error);
      throw error;
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
    const drain = await takeDrain(index);
    if (action) {
      await watch.after(page, step, index, { settle, drain });
    }
  }

  if (assertion.expectedAnnouncement === undefined) {
    return [];
  }
  const expectedAnnouncement = assertion.expectedAnnouncement;

  const node = await page.activeNode();
  const focusAfter = focusMark(await focusedNodeIdOrUnknown(page), node);
  if (drainFailures.length > 0) {
    throw drainFailures[0];
  }
  const drain = unionOfDrains(drains);
  const own = await flowVerdict(page, requirement, expectedAnnouncement, node, drain, {
    textsBefore: drainBefore?.texts ?? [],
    focusBefore,
    focusMoved: focusChanged(focusBefore, focusAfter),
  });
  // The rule stays quiet only where it would repeat the flow's own draft for the same step. A flow
  // that fails says its last step was not heard, so the rule emits nothing for that step: a second
  // draft would be a second finding for one accessibility barrier. A flow gap about an undecidable
  // drain names the first such drain, so the rule drops its own undecidable gap on that step only.
  if (own.some((draft) => draft.confidence === 'fail')) {
    watch.quiet(assertion.steps.length - 1);
  } else if (own.length > 0 && drain.undecidable !== null) {
    const undecidableStep = drainSteps[drains.findIndex((entry) => entry.undecidable !== null)];
    if (undecidableStep !== undefined) {
      watch.dropGap(undecidableStep, 'announcements undecidable');
    }
  }
  return own;
}

// What the flow knows about the page before its first step. None of it passes the flow.
interface FlowStart {
  // The texts of the drain taken before the first step. They never pass the flow and never fail it.
  textsBefore: readonly string[];
  // What had focus before the first step, or null when it could not be read.
  focusBefore: FocusMark | null;
  // Whether the flow's steps changed what has focus.
  focusMoved: boolean;
}

async function flowVerdict(
  page: Page,
  requirement: Requirement,
  expectedAnnouncement: string,
  node: AxNode | null,
  drain: AnnouncementDrain,
  before: FlowStart,
): Promise<Draft[]> {
  const announcements = drain.texts;
  const heardOnFocus = trimEqual(node?.name ?? null, expectedAnnouncement);
  // The focused control's name counts only when the flow's steps changed what has focus.
  if (heardOnFocus && before.focusMoved) {
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

  if (heardOnFocus) {
    return [
      flowFocusUnchangedDraft(requirement, node, await page.activePath(), expectedAnnouncement, announcements, before.focusBefore !== null),
    ];
  }

  const unreadable = await page.activeFocusUnreadable();
  if (unreadable !== null) {
    return [flowUnreadableDraft(requirement, await page.activePath(), expectedAnnouncement, announcements, unreadable)];
  }

  if (before.textsBefore.some((text) => trimEqual(text, expectedAnnouncement))) {
    return [flowHeardBeforeDraft(requirement, node, await page.activePath(), expectedAnnouncement, announcements)];
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
