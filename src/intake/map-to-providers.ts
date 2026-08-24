/**
 * Maps authored intake requirements to deterministic runtime Providers.
 * Intake drafts are direct observations against authored strings and actions, but they still
 * never mint a verdict because the gate remains the only verdict authority.
 * Documentation requirements emit no Provider because they define output artifacts, not checks.
 */
import type {
  AxNode,
  ContentAssertion,
  Draft,
  FlowAssertion,
  Page,
  Provider,
  Requirement,
  RequirementBundle,
  Step,
} from '../contracts/index.js';

function hasNonEmptyName(name: string | null): boolean {
  return name !== null && name.trim().length > 0;
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

function toContentProvider(requirement: Requirement, assertion: ContentAssertion): Provider {
  return {
    id: `intake:${requirement.id}`,
    layer: 'intake-content',
    capabilities: ['live'],
    async run(ctx) {
      // Wrong surface is out of scope for this scan. Coverage wiring decides this later.
      if (ctx.screen.id !== requirement.surface) {
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
    async run(ctx) {
      // Wrong surface is out of scope for this scan. Coverage wiring decides this later.
      if (ctx.screen.id !== requirement.surface) {
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
      const announcements = await ctx.page.drainAnnouncements();
      const heardOnFocus = (node?.name ?? '').includes(expectedAnnouncement);
      const heardInAnnouncements = announcements.some((announcement) =>
        announcement.includes(expectedAnnouncement),
      );

      if (heardOnFocus || heardInAnnouncements) {
        return [];
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
