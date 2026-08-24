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
} from '../contracts/index.js';

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
]);

const requirementSchema = z
  .object({
    id: z.string().min(1, 'id is required'),
    kind: z.enum(['content', 'flow', 'doc']),
    surface: z.string().min(1, 'surface is required'),
    description: z.string().min(1, 'description is required'),
    assertion: assertionSchema,
    owner: z.string().min(1, 'owner must not be empty').optional(),
    approved: z.boolean(),
  })
  .strict()
  .superRefine((requirement, ctx) => {
    if (requirement.kind !== requirement.assertion.type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: 'kind must match assertion.type',
      });
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

function toAssertion(assertion: z.infer<typeof assertionSchema>): Requirement['assertion'] {
  switch (assertion.type) {
    case 'content':
      return toContentAssertion(assertion);
    case 'flow':
      return toFlowAssertion(assertion);
    case 'doc':
      return toDocAssertion(assertion);
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
