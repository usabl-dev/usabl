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
import { scrubString } from '../surfaces/scrub.js';
import { normalizeToken } from '../voicing/normalize.js';
import { describeFileKeyProblem, describeNodeIdProblem, describeVersionProblem } from './design-source.js';
import { describeRequirementIdProblem } from './requirement-ids.js';

export type ParseBundleResult =
  | { ok: true; bundle: RequirementBundle }
  | { ok: false; verdict: 'approval_required'; reason: string };

// The type name of a value, as the messages below print it.
function receivedType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isNaN(value) ? 'nan' : 'number';
  if (value instanceof Date) return 'date';
  if (value instanceof Map) return 'map';
  if (value instanceof Set) return 'set';
  return typeof value;
}

function quoteValues(values: readonly unknown[], separator = ' | '): string {
  return values.map((value) => (typeof value === 'string' ? `'${value}'` : String(value))).join(separator);
}

// A count as a person reads it, such as 1,000.
function count(limit: number): string {
  return limit.toLocaleString('en-US');
}

// An unknown-key message names at most this many keys, and each name at most this many
// characters. A key name is file text, so its secrets are taken out before it is cut, and a cut
// can never leave part of a secret behind.
const KEYS_SHOWN = 5;
const KEY_NAME_CHARS = 60;

function keyName(key: string): string {
  const safe = [...scrubString(key)];
  return safe.length > KEY_NAME_CHARS ? `${safe.slice(0, KEY_NAME_CHARS).join('')}...` : safe.join('');
}

function keyList(keys: readonly string[], quote: boolean): string {
  const shown = keys.slice(0, KEYS_SHOWN).map((key) => (quote ? `'${keyName(key)}'` : keyName(key)));
  const rest = keys.length - shown.length;
  return rest > 0 ? `${shown.join(', ')}, and ${count(rest)} more` : shown.join(', ');
}

function invalidTypeMessage(expected: string, input: unknown): string {
  return input === undefined ? 'Required' : `Expected ${expected}, received ${receivedType(input)}`;
}

// The messages for the mistakes the schema library reports in its own words: a missing field, a
// wrong type, an unknown key, or a value that is not one of the allowed ones. These are the words
// usabl has always printed. The library's version 4 words them differently, so they are written
// out here, and a library upgrade cannot change what a person reads. A schema's own message, such
// as 'description is required', comes first. This map is used only where a schema has none.
const issueMessage: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      return invalidTypeMessage(issue.expected, issue.input);
    case 'invalid_value': {
      // An enum and a literal both report a value that is not allowed, in different words.
      const def = issue.inst?._zod.def;
      if (def !== undefined && 'type' in def && def.type === 'enum') {
        return typeof issue.input === 'string'
          ? `Invalid enum value. Expected ${quoteValues(issue.values)}, received '${issue.input}'`
          : invalidTypeMessage(quoteValues(issue.values), issue.input);
      }
      return `Invalid literal value, expected ${issue.values.map((value) => JSON.stringify(value)).join(' | ')}`;
    }
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${keyList(issue.keys, true)}`;
    case 'invalid_union':
      // Only a discriminated union names its discriminator, and then options lists its values.
      return issue.discriminator !== undefined && 'options' in issue && Array.isArray(issue.options)
        ? `Invalid discriminator value. Expected ${quoteValues(issue.options)}`
        : 'Invalid input';
    default:
      return undefined;
  }
};

// A number field. YAML can write an infinite number (.inf), and the schema library before its
// version 4 took it as a number, so the field's own rule refused it with a message that names the
// field's range. Version 4 refuses it sooner, as not a number. This keeps the old order: any
// number but NaN passes here, and the field's rule then refuses Infinity in its own words. A value
// that is not a number stops the field here, so no later rule reads it.
function numberField(requiredMessage = 'Required') {
  return z.custom<number>((value) => typeof value === 'number' && !Number.isNaN(value), {
    abort: true,
    error: (issue) => (issue.input === undefined ? requiredMessage : invalidTypeMessage('number', issue.input)),
  });
}

const contentAssertionSchema = z
  .object({
    type: z.literal('content'),
    selector: z.string().min(1, 'selector is required'),
    expectedText: z.string().min(1, 'expectedText must not be empty').optional(),
    mustNotBe: z.enum(['decorative', 'empty']).optional(),
  })
  .strict();

// The most entries each list in a requirement file may hold. A real file holds a few of each. A
// list past its limit is refused on its length alone, before any entry is read, so a huge file is
// refused fast, with one message, and is never cut short or read in part.
const REQUIREMENTS_LIMIT = 1000;
const STEPS_LIMIT = 1000;
const STEP_FIELDS_LIMIT = 100;
// One requirement holds its obligations and each obligation's words, so a bad requirement can hold
// up to obligations times words problems. The schema library collects the problems of one list
// entry in a single call, and past about 123,000 of them that call fails (see parseBundle). These
// two limits keep one requirement under about 13,000 problems.
const OBLIGATIONS_LIMIT = 100;
const TOKENS_LIMIT = 100;

function atMost(list: string, limit: number, items: string): string {
  return `${list} can list at most ${count(limit)} ${items}`;
}

// A flow step keeps the fields it does not name, for the step runner to read. Their number is
// checked first, so a step with a huge number of fields is refused on that alone.
const flowStepSchema = z
  .custom<unknown>(
    (input) =>
      typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).length <= STEP_FIELDS_LIMIT,
    { abort: true, error: `a flow step can have at most ${count(STEP_FIELDS_LIMIT)} fields` },
  )
  .pipe(
    z
      .object({
        do: z.string().min(1, 'steps[].do is required'),
      })
      .catchall(z.unknown()),
  );

const flowAssertionSchema = z
  .object({
    type: z.literal('flow'),
    steps: z
      .array(flowStepSchema)
      .min(1, 'flow steps must contain at least one action')
      .max(STEPS_LIMIT, atMost('flow steps', STEPS_LIMIT, 'steps')),
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
      error: (issue) =>
        issue.code === 'unrecognized_keys'
          ? `${keyList(issue.keys, false)} is not a field of a ${kind} step; write only ${write}`
          : undefined,
    })
    .strict();
}

const requiredText = (message: string) => z.string({ error: message }).trim().min(1, message);

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
    error: (issue) =>
      issue.code === 'invalid_union'
        ? 'do must be tab, activate, press, or click; to press another key, write do: press with key, such as key: Escape'
        : undefined,
  },
);

const voiceObligationSchema = z
  .object({
    class: z.string().trim().min(1, 'class is required; name the kind of obligation, such as live-polite'),
    afterStep: numberField(),
    requiredTokens: z
      .array(z.string())
      .min(1, 'requiredTokens must list at least one word a screen reader user must hear')
      .max(TOKENS_LIMIT, atMost('requiredTokens', TOKENS_LIMIT, 'words')),
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
      .min(1, 'voice steps must list at least one step, such as a click on the control under test')
      .max(STEPS_LIMIT, atMost('voice steps', STEPS_LIMIT, 'steps')),
    obligations: z
      .array(voiceObligationSchema)
      .min(1, 'voice obligations must list at least one obligation, saying what a screen reader user must hear')
      .max(OBLIGATIONS_LIMIT, atMost('voice obligations', OBLIGATIONS_LIMIT, 'obligations')),
    maxTabPath: numberField().optional(),
  })
  .strict();

// Rules for a voice assertion that need more than one field at a time, so they cannot live in the
// object schema. The discriminated union needs plain object schemas, so these run from the
// requirement refinement, with paths under assertion.
function refineVoiceAssertion(assertion: z.infer<typeof voiceAssertionSchema>, ctx: z.core.$RefinementCtx): void {
  // An obligation is checked in the window after one step, so afterStep has to name a step that
  // exists. A window past the last step would never be reached, and the obligation would only
  // ever report that focus did not get there.
  const lastStep = assertion.steps.length - 1;
  assertion.obligations.forEach((obligation, index) => {
    if (!Number.isInteger(obligation.afterStep) || obligation.afterStep < 0 || obligation.afterStep > lastStep) {
      ctx.addIssue({
        code: 'custom',
        path: ['assertion', 'obligations', index, 'afterStep'],
        message: `afterStep must be a whole number from 0 to ${lastStep}, the position of a step in steps counted from 0`,
      });
    }
    // The matcher compares letters and digits only. A token with none of them compares as empty,
    // and an empty token is found in every announcement, so it would pass on silence.
    obligation.requiredTokens.forEach((token, tokenIndex) => {
      if (normalizeToken(token).length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['assertion', 'obligations', index, 'requiredTokens', tokenIndex],
          message:
            'each requiredTokens entry must contain a letter or digit; a token of only spaces or punctuation would match any announcement',
        });
      }
    });
  });
  if (assertion.maxTabPath !== undefined && (!Number.isInteger(assertion.maxTabPath) || assertion.maxTabPath < 1)) {
    ctx.addIssue({
      code: 'custom',
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
    level: z.literal([1, 2, 3, 4, 5, 6], { error: 'level must be a whole number from 1 to 6' }),
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
      .max(FOCUS_SEQUENCE_LIMIT, atMost('sequence', FOCUS_SEQUENCE_LIMIT, 'names')),
  })
  .strict();

const targetSizeAssertionSchema = z
  .object({
    type: z.literal('target-size'),
    target: targetSchema,
    minCssPx: numberField('minCssPx is required: the smallest width and height, in CSS pixels, such as 24').superRefine(
      (minCssPx, ctx) => {
        // The hit test needs a box at least 2 pixels on each side for its points, and skips a smaller
        // one. A minimum of 2 or more fails such a box on size, so it can never pass without a hit test.
        if (minCssPx < 2) {
          ctx.addIssue({ code: 'custom', message: 'minCssPx must be at least 2 CSS pixels' });
        }
        if (minCssPx > 200) {
          ctx.addIssue({ code: 'custom', message: 'minCssPx must be at most 200 CSS pixels' });
        }
      },
    ),
  })
  .strict();

// The design tool fields a requirement records. Each one is checked against a narrow set of
// visible characters, because each later goes into a URL or a report line.
const sourceText = (describe: (value: string) => string | null) =>
  z.string().superRefine((value, ctx) => {
    const problem = describe(value);
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: problem });
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
function refineFocusOrder(assertion: z.infer<typeof focusOrderAssertionSchema>, ctx: z.core.$RefinementCtx): void {
  const seen = new Set<string>();
  assertion.sequence.forEach((name, index) => {
    if (seen.has(name)) {
      ctx.addIssue({
        code: 'custom',
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
          code: 'custom',
          path: [field],
          message: problem,
        });
      }
    }

    if (requirement.kind !== requirement.assertion.type) {
      ctx.addIssue({
        code: 'custom',
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
    requirements: z
      .array(requirementSchema)
      .min(1, 'requirements must contain at least one entry')
      .max(REQUIREMENTS_LIMIT, `${atMost('requirements', REQUIREMENTS_LIMIT, 'requirements')}; put the rest in another file`),
  })
  .strict();

// A path segment can be a symbol in the library's types. Parsed YAML has no symbol keys, so that
// case only keeps the text readable if one ever appears.
function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return 'bundle';
  }

  let formatted = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`;
      continue;
    }
    const name = String(segment);
    formatted += formatted.length === 0 ? name : `.${name}`;
  }
  return formatted;
}

function isSizeIssue(issue: z.core.$ZodIssue): boolean {
  return issue.code === 'too_small' || issue.code === 'too_big';
}

function isUnder(path: readonly PropertyKey[], parent: readonly PropertyKey[]): boolean {
  return path.length > parent.length && parent.every((segment, index) => path[index] === segment);
}

/**
 * The issues in the order, and with the content, that usabl has always reported them. The schema
 * library's version 4 differs from earlier versions in two ways, and both are undone here.
 *
 * It still runs a length rule on a value of the wrong type when that value has a length, such as a
 * list written where text belongs. That adds a second message for the field after the one that
 * says its type is wrong, and the second message only restates the first. Earlier versions stopped
 * at the type message, so a length message for a field whose type was wrong is dropped.
 *
 * It checks the entries of a list before the list's own length, so a list that is too short and
 * holds a bad entry reports the entry first. Earlier versions reported the length first, so the
 * length message moves back in front of the messages for the list's entries.
 */
function inReportedOrder(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  // Only a length problem is ever dropped, so only the paths of length problems are looked up. A
  // file can hold over 100,000 type problems, and none of their paths is built unless it could
  // match one.
  const sizePaths = new Set(issues.filter(isSizeIssue).map((issue) => formatIssuePath(issue.path)));
  const wrongType = new Set<string>();
  const ordered: z.core.$ZodIssue[] = [];
  for (const issue of issues) {
    if (sizePaths.size > 0 && issue.code === 'invalid_type') {
      const where = formatIssuePath(issue.path);
      if (sizePaths.has(where)) {
        wrongType.add(where);
      }
    } else if (isSizeIssue(issue) && wrongType.has(formatIssuePath(issue.path))) {
      continue;
    }
    let at = ordered.length;
    if (isSizeIssue(issue) && 'origin' in issue && issue.origin === 'array') {
      while (at > 0 && isUnder(ordered[at - 1]?.path ?? [], issue.path)) {
        at -= 1;
      }
    }
    ordered.splice(at, 0, issue);
  }
  return ordered;
}

// A refusal lists at most this many problems, then says how many more the file has. A file within
// every limit can still hold over 100,000 problems, and the first ones are enough to start fixing.
const PROBLEMS_SHOWN = 100;

function formatValidationReason(issues: readonly z.core.$ZodIssue[]): string {
  if (issues.length === 0) {
    return 'requirement bundle did not match schema';
  }

  const ordered = inReportedOrder(issues);
  const shown = ordered
    .slice(0, PROBLEMS_SHOWN)
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join('; ');
  const rest = ordered.length - PROBLEMS_SHOWN;
  return rest > 0 ? `${shown}; and ${count(rest)} more ${rest === 1 ? 'problem' : 'problems'}` : shown;
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

const TOO_MANY_PROBLEMS = 'this file has too many problems to check, so it is refused; shorten or fix its longest list';

// The message the JavaScript engine gives when a call goes over its stack or argument limit.
const STACK_LIMIT_MESSAGE = 'Maximum call stack size exceeded';

export function parseBundle(raw: unknown): ParseBundleResult {
  // The schema library collects the problems of a list entry with one function call that takes
  // each problem as an argument. Past about 123,000 problems under one entry, that call goes over
  // the engine's limit and throws a RangeError in place of returning them. The file is refused
  // either way. This says why, and quotes nothing from the file, so the person is not told that
  // valid YAML is invalid. Any other error, a RangeError with another message included, is a fault
  // that says nothing about the file, so it is thrown on as before. The list limits above keep one
  // requirement under about 13,000 problems, so no file within them reaches this today. The catch
  // stays in case a later change or a much smaller stack lets one through.
  let parsed: z.ZodSafeParseResult<z.infer<typeof requirementBundleSchema>>;
  try {
    parsed = requirementBundleSchema.safeParse(raw, { error: issueMessage });
  } catch (error: unknown) {
    if (error instanceof RangeError && error.message === STACK_LIMIT_MESSAGE) {
      return { ok: false, verdict: 'approval_required', reason: TOO_MANY_PROBLEMS };
    }
    throw error;
  }

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
