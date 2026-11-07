/**
 * Intake schema validator for requirement bundles.
 * It enforces a single, explicit contract before requirement data enters the engine.
 * It must never invent defaults, silently drop ambiguous fields, or pass malformed intake.
 *
 * Malformed intake is an approval_required disclosure so humans can resolve ambiguity.
 * Strict object schemas keep unknown keys from being mistaken as acceptable input.
 */
import { z } from 'zod';
import type {
  ContentAssertion,
  DocAssertion,
  FlowAssertion,
  Requirement,
  RequirementBundle,
  SpeechObligation,
  VoiceAssertion,
} from '../contracts/index.js';
import { normalizeToken } from '../voicing/normalize.js';
import { describeRequirementIdProblem } from './requirement-ids.js';

export type ParseBundleResult =
  | { ok: true; bundle: RequirementBundle }
  | { ok: false; verdict: 'approval_required'; reason: string };

const contentAssertionSchema = z
  .object({
    type: z.literal('content'),
    selector: z.string().min(1, 'selector is required'),
    expectedText: z.string().min(1, 'expectedText must not be empty').optional(),
    mustNotBe: z.enum(['decorative', 'empty']).optional(),
  })
  .strict();

const flowStepSchema = z
  .object({
    do: z.string().min(1, 'steps[].do is required'),
  })
  .catchall(z.unknown());

const flowAssertionSchema = z
  .object({
    type: z.literal('flow'),
    steps: z.array(flowStepSchema).min(1, 'flow steps must contain at least one action'),
    expectedAnnouncement: z
      .string()
      .min(1, 'expectedAnnouncement must not be empty')
      .optional(),
  })
  .strict();

const voiceObligationSchema = z
  .object({
    class: z.string().min(1, 'class is required; name the kind of obligation, such as live-polite'),
    afterStep: z.number(),
    requiredTokens: z
      .array(z.string())
      .min(1, 'requiredTokens must list at least one word a screen reader user must hear'),
    focusedRole: z.string().optional(),
    mustAnnounce: z.boolean(),
  })
  .strict();

const voiceAssertionSchema = z
  .object({
    type: z.literal('voice'),
    steps: z
      .array(flowStepSchema)
      .min(1, 'voice steps must list at least one step, such as a click on the control under test'),
    obligations: z
      .array(voiceObligationSchema)
      .min(1, 'voice obligations must list at least one obligation, saying what a screen reader user must hear'),
    maxTabPath: z.number().optional(),
  })
  .strict();

// Rules for a voice assertion that need more than one field at a time, so they cannot live in the
// object schema. The discriminated union needs plain object schemas, so these run from the
// requirement refinement, with paths under assertion.
function refineVoiceAssertion(assertion: z.infer<typeof voiceAssertionSchema>, ctx: z.RefinementCtx): void {
  // An obligation is checked in the window after one step, so afterStep has to name a step that
  // exists. A window past the last step would never be reached, and the obligation would only
  // ever report that focus did not get there.
  const lastStep = assertion.steps.length - 1;
  assertion.obligations.forEach((obligation, index) => {
    if (!Number.isInteger(obligation.afterStep) || obligation.afterStep < 0 || obligation.afterStep > lastStep) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assertion', 'obligations', index, 'afterStep'],
        message: `afterStep must be a whole number from 0 to ${lastStep}, the position of a step in steps counted from 0`,
      });
    }
    // The matcher compares letters and digits only. A token with none of them compares as empty,
    // and an empty token is found in every announcement, so it would pass on silence.
    obligation.requiredTokens.forEach((token, tokenIndex) => {
      if (normalizeToken(token).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assertion', 'obligations', index, 'requiredTokens', tokenIndex],
          message:
            'each requiredTokens entry must contain a letter or digit; a token of only spaces or punctuation would match any announcement',
        });
      }
    });
  });
  if (assertion.maxTabPath !== undefined && (!Number.isInteger(assertion.maxTabPath) || assertion.maxTabPath < 1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['assertion', 'maxTabPath'],
      message: 'maxTabPath must be a positive whole number, the most focus stops the task may take, or left out',
    });
  }
}

const docAssertionSchema = z
  .object({
    type: z.literal('doc'),
    artifact: z.enum(['alt-text-manifest', 'announcement-snippets', 'keyboard-paths']),
  })
  .strict();

const assertionSchema = z.discriminatedUnion('type', [
  contentAssertionSchema,
  flowAssertionSchema,
  docAssertionSchema,
  voiceAssertionSchema,
]);

const requirementSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['content', 'flow', 'doc', 'voice']),
    surface: z.string(),
    description: z.string().min(1, 'description is required'),
    assertion: assertionSchema,
    owner: z.string().min(1, 'owner must not be empty').optional(),
    approved: z.boolean(),
  })
  .strict()
  .superRefine((requirement, ctx) => {
    // The id becomes the rule a waiver matches on, and the surface is the other half of the waiver
    // key and the screen the requirement is checked on. Both have to be readable as identities
    // before anything else looks at them, so both go through the shared id grammar, which also
    // refuses the empty string. This runs per requirement because it is a shape rule for one
    // field. Uniqueness needs the whole directory and is checked by the loader.
    for (const field of ['id', 'surface'] as const) {
      const problem = describeRequirementIdProblem(requirement[field]);
      if (problem !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: problem,
        });
      }
    }

    if (requirement.kind !== requirement.assertion.type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: 'kind must match assertion.type',
      });
    }

    if (requirement.assertion.type === 'voice') {
      refineVoiceAssertion(requirement.assertion, ctx);
    }
  });

const requirementBundleSchema = z
  .object({
    version: z.literal(1),
    requirements: z.array(requirementSchema).min(1, 'requirements must contain at least one entry'),
  })
  .strict();

function formatIssuePath(path: Array<string | number>): string {
  if (path.length === 0) {
    return 'bundle';
  }

  let formatted = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`;
      continue;
    }
    formatted += formatted.length === 0 ? segment : `.${segment}`;
  }
  return formatted;
}

function formatValidationReason(issues: z.ZodIssue[]): string {
  if (issues.length === 0) {
    return 'requirement bundle did not match schema';
  }

  return issues
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join('; ');
}

function toContentAssertion(assertion: z.infer<typeof contentAssertionSchema>): ContentAssertion {
  const normalized: ContentAssertion = {
    type: 'content',
    selector: assertion.selector,
  };

  if (assertion.expectedText !== undefined) {
    normalized.expectedText = assertion.expectedText;
  }
  if (assertion.mustNotBe !== undefined) {
    normalized.mustNotBe = assertion.mustNotBe;
  }

  return normalized;
}

function toFlowAssertion(assertion: z.infer<typeof flowAssertionSchema>): FlowAssertion {
  const normalized: FlowAssertion = {
    type: 'flow',
    steps: assertion.steps,
  };

  if (assertion.expectedAnnouncement !== undefined) {
    normalized.expectedAnnouncement = assertion.expectedAnnouncement;
  }

  return normalized;
}

function toDocAssertion(assertion: z.infer<typeof docAssertionSchema>): DocAssertion {
  return {
    type: 'doc',
    artifact: assertion.artifact,
  };
}

function toVoiceObligation(obligation: z.infer<typeof voiceObligationSchema>): SpeechObligation {
  const normalized: SpeechObligation = {
    class: obligation.class,
    afterStep: obligation.afterStep,
    requiredTokens: [...obligation.requiredTokens],
    mustAnnounce: obligation.mustAnnounce,
  };

  if (obligation.focusedRole !== undefined) {
    normalized.focusedRole = obligation.focusedRole;
  }

  return normalized;
}

function toVoiceAssertion(assertion: z.infer<typeof voiceAssertionSchema>): VoiceAssertion {
  const normalized: VoiceAssertion = {
    type: 'voice',
    steps: assertion.steps,
    obligations: assertion.obligations.map((obligation) => toVoiceObligation(obligation)),
  };

  if (assertion.maxTabPath !== undefined) {
    normalized.maxTabPath = assertion.maxTabPath;
  }

  return normalized;
}

function toAssertion(assertion: z.infer<typeof assertionSchema>): Requirement['assertion'] {
  switch (assertion.type) {
    case 'content':
      return toContentAssertion(assertion);
    case 'flow':
      return toFlowAssertion(assertion);
    case 'doc':
      return toDocAssertion(assertion);
    case 'voice':
      return toVoiceAssertion(assertion);
  }
}

function toRequirement(requirement: z.infer<typeof requirementSchema>): Requirement {
  const normalized: Requirement = {
    id: requirement.id,
    kind: requirement.kind,
    surface: requirement.surface,
    description: requirement.description,
    assertion: toAssertion(requirement.assertion),
    approved: requirement.approved,
  };

  if (requirement.owner !== undefined) {
    normalized.owner = requirement.owner;
  }

  return normalized;
}

function toRequirementBundle(bundle: z.infer<typeof requirementBundleSchema>): RequirementBundle {
  return {
    version: 1,
    requirements: bundle.requirements.map((requirement) => toRequirement(requirement)),
  };
}

export function parseBundle(raw: unknown): ParseBundleResult {
  const parsed = requirementBundleSchema.safeParse(raw);

  if (parsed.success) {
    return {
      ok: true,
      bundle: toRequirementBundle(parsed.data),
    };
  }

  return {
    ok: false,
    verdict: 'approval_required',
    reason: formatValidationReason(parsed.error.issues),
  };
}
