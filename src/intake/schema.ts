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
  LandmarkAssertion,
  LandmarkRole,
  Requirement,
  RequirementBundle,
  SpeechObligation,
  TargetRole,
  VoiceAssertion,
} from '../contracts/index.js';
import { collapseWhiteSpace } from '../primitives/accessible-name.js';
import { normalizeToken } from '../voicing/normalize.js';
import { describeFileKeyProblem, describeNodeIdProblem, describeVersionProblem } from './design-source.js';
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

// A voice step is one the contract step runner can run, with the field it needs. A step it cannot
// run would only fail when the scan reaches it, so it is refused here, where the message can say
// what to write. Each kind takes only the fields it uses.
function voiceStepSchema<Shape extends z.ZodRawShape>(kind: string, shape: Shape, write: string) {
  return z
    .object(shape, {
      errorMap: (issue, ctx) =>
        issue.code === z.ZodIssueCode.unrecognized_keys
          ? { message: `${issue.keys.join(', ')} is not a field of a ${kind} step; write only ${write}` }
          : { message: ctx.defaultError },
    })
    .strict();
}

const requiredText = (message: string) =>
  z.string({ required_error: message, invalid_type_error: message }).trim().min(1, message);

const PRESS_KEY_MESSAGE = 'a press step needs a key, such as key: Escape';
const CLICK_SELECTOR_MESSAGE = "a click step needs a selector, such as selector: '#delete'";

const voiceStepsSchema = z.discriminatedUnion(
  'do',
  [
    voiceStepSchema('tab', { do: z.literal('tab') }, 'do: tab'),
    voiceStepSchema('activate', { do: z.literal('activate') }, 'do: activate'),
    voiceStepSchema('press', { do: z.literal('press'), key: requiredText(PRESS_KEY_MESSAGE) }, 'do: press and key'),
    voiceStepSchema('click', { do: z.literal('click'), selector: requiredText(CLICK_SELECTOR_MESSAGE) }, 'do: click and selector'),
  ],
  {
    errorMap: (issue, ctx) =>
      issue.code === z.ZodIssueCode.invalid_union_discriminator
        ? { message: 'do must be tab, activate, press, or click; to press another key, write do: press with key, such as key: Escape' }
        : { message: ctx.defaultError },
  },
);

const voiceObligationSchema = z
  .object({
    class: z.string().trim().min(1, 'class is required; name the kind of obligation, such as live-polite'),
    afterStep: z.number(),
    requiredTokens: z
      .array(z.string())
      .min(1, 'requiredTokens must list at least one word a screen reader user must hear'),
    focusedRole: z
      .string()
      .trim()
      .min(1, 'focusedRole must not be empty; name a role such as button, or leave it out')
      .optional(),
    mustAnnounce: z.boolean(),
  })
  .strict();

const voiceAssertionSchema = z
  .object({
    type: z.literal('voice'),
    steps: z
      .array(voiceStepsSchema)
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

// The roles a design requirement can name. LANDMARK_ROLES is the subset a landmark check takes.
const TARGET_ROLES = [
  'button',
  'link',
  'heading',
  'img',
  'textbox',
  'checkbox',
  'menuitem',
  'tab',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'search',
  'form',
] as const satisfies readonly TargetRole[];
const LANDMARK_ROLES = [
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'search',
  'form',
] as const satisfies readonly LandmarkRole[];

// The browser reports an accessible name with each run of ASCII white space as one space, so a
// name is stored that way, with none at either end, and compared that way (collapseWhiteSpace). A
// name that is empty then would match nothing a person could have meant.
const accessibleName = (field: string) =>
  z
    .string()
    .transform((value) => collapseWhiteSpace(value))
    .pipe(z.string().min(1, `${field} must not be empty`));

const targetSchema = z
  .object({
    role: z.enum(TARGET_ROLES),
    name: accessibleName('name'),
  })
  .strict();

const nameAssertionSchema = z.object({ type: z.literal('name'), target: targetSchema }).strict();

const headingAssertionSchema = z
  .object({
    type: z.literal('heading'),
    name: accessibleName('name'),
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)], {
      errorMap: () => ({ message: 'level must be a whole number from 1 to 6' }),
    }),
  })
  .strict();

const landmarkAssertionSchema = z
  .object({
    type: z.literal('landmark'),
    role: z.enum(LANDMARK_ROLES),
    name: accessibleName('name').optional(),
  })
  .strict();

// The walk that checks a focus order stops after this many focus stops, so a longer sequence could
// never be reached.
const FOCUS_SEQUENCE_LIMIT = 200;

const focusOrderAssertionSchema = z
  .object({
    type: z.literal('focus-order'),
    sequence: z
      .array(accessibleName('each sequence entry'))
      .min(2, 'sequence needs at least two names, because one name has no order')
      .max(FOCUS_SEQUENCE_LIMIT, `sequence can list at most ${FOCUS_SEQUENCE_LIMIT} names`),
  })
  .strict();

const targetSizeAssertionSchema = z
  .object({
    type: z.literal('target-size'),
    target: targetSchema,
    minCssPx: z
      .number({ required_error: 'minCssPx is required: the smallest width and height, in CSS pixels, such as 24' })
      .positive('minCssPx must be more than 0')
      .max(200, 'minCssPx must be at most 200 CSS pixels'),
  })
  .strict();

// The design tool fields a requirement records. Each one is checked against a narrow set of
// visible characters, because each later goes into a URL or a report line.
const sourceText = (describe: (value: string) => string | null) =>
  z.string().superRefine((value, ctx) => {
    const problem = describe(value);
    if (problem !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }
  });

const sourceSchema = z
  .object({
    tool: z.literal('figma'),
    file: sourceText(describeFileKeyProblem),
    node: sourceText(describeNodeIdProblem),
    version: sourceText(describeVersionProblem),
  })
  .strict();

const assertionSchema = z.discriminatedUnion('type', [
  contentAssertionSchema,
  flowAssertionSchema,
  docAssertionSchema,
  voiceAssertionSchema,
  nameAssertionSchema,
  headingAssertionSchema,
  landmarkAssertionSchema,
  focusOrderAssertionSchema,
  targetSizeAssertionSchema,
]);

// A focus order names each stop once. A name listed twice could be either of two stops, and
// checking it would be a guess about which one the design meant, so the file is refused instead.
function refineFocusOrder(assertion: z.infer<typeof focusOrderAssertionSchema>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  assertion.sequence.forEach((name, index) => {
    if (seen.has(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assertion', 'sequence', index],
        message: 'this name repeats an earlier entry; list each name once, so the check never has to guess which stop is meant',
      });
    }
    seen.add(name);
  });
}

const requirementSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['content', 'flow', 'doc', 'voice', 'name', 'heading', 'landmark', 'focus-order', 'target-size']),
    surface: z.string(),
    description: z.string().min(1, 'description is required'),
    assertion: assertionSchema,
    owner: z.string().min(1, 'owner must not be empty').optional(),
    approved: z.boolean(),
    source: sourceSchema.optional(),
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

    if (requirement.assertion.type === 'focus-order') {
      refineFocusOrder(requirement.assertion, ctx);
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

function toLandmarkAssertion(assertion: z.infer<typeof landmarkAssertionSchema>): LandmarkAssertion {
  const normalized: LandmarkAssertion = { type: 'landmark', role: assertion.role };
  if (assertion.name !== undefined) {
    normalized.name = assertion.name;
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
    case 'name':
      return { type: 'name', target: { role: assertion.target.role, name: assertion.target.name } };
    case 'heading':
      return { type: 'heading', name: assertion.name, level: assertion.level };
    case 'landmark':
      return toLandmarkAssertion(assertion);
    case 'focus-order':
      return { type: 'focus-order', sequence: [...assertion.sequence] };
    case 'target-size':
      return {
        type: 'target-size',
        target: { role: assertion.target.role, name: assertion.target.name },
        minCssPx: assertion.minCssPx,
      };
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
  if (requirement.source !== undefined) {
    normalized.source = { ...requirement.source };
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
