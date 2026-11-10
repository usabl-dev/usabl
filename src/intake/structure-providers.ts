/**
 * Providers for the requirement kinds designers annotate: an element's name, a heading level, a
 * landmark, a focus order, and a target size. Each one finds its elements by role and accessible
 * name, reports drafts only, and never decides a verdict. Each one checks only its own surface.
 *
 * A check that cannot tell which element the design means, or cannot read what it needs, says so
 * with an unconfirmed draft (confidence 'unverified'). That keeps the screen from reading as
 * checked, and it is never a pass and never a fail. A check fails only on what it read: an element
 * that is missing from what it searched, a level, a size, or an order.
 */
import type {
  AxNode,
  Draft,
  FocusOrderAssertion,
  FocusUnreadable,
  HeadingAssertion,
  LandmarkAssertion,
  NameAssertion,
  Page,
  Provider,
  Requirement,
  RoleTarget,
  TargetRole,
  TargetSizeAssertion,
} from '../contracts/index.js';
import { focusUnreadableCause } from '../primitives/focus-unreadable.js';
import { findByRole, resolveTarget, sameName, type TargetResolution } from './resolve-target.js';

/** The layer of each design check, one per kind, as the content and flow checks have. */
export const DESIGN_CHECK_LAYERS = {
  name: 'intake-name',
  heading: 'intake-heading',
  landmark: 'intake-landmark',
  'focus-order': 'intake-focus-order',
  'target-size': 'intake-target-size',
} as const;

type DesignKind = keyof typeof DESIGN_CHECK_LAYERS;

// How each role reads in a sentence.
const ROLE_WORD: Readonly<Record<TargetRole, string>> = {
  button: 'button',
  link: 'link',
  heading: 'heading',
  img: 'image',
  textbox: 'text field',
  checkbox: 'checkbox',
  menuitem: 'menu item',
  tab: 'tab',
  main: 'main content area',
  navigation: 'navigation area',
  banner: 'page header',
  contentinfo: 'page footer',
  complementary: 'side area',
  region: 'named region',
  search: 'search area',
  form: 'form',
};

const ROLE_PLURAL: Readonly<Record<TargetRole, string>> = {
  button: 'buttons',
  link: 'links',
  heading: 'headings',
  img: 'images',
  textbox: 'text fields',
  checkbox: 'checkboxes',
  menuitem: 'menu items',
  tab: 'tabs',
  main: 'main content areas',
  navigation: 'navigation areas',
  banner: 'page headers',
  contentinfo: 'page footers',
  complementary: 'side areas',
  region: 'named regions',
  search: 'search areas',
  form: 'forms',
};

// Where a page-level finding points. A finding about what the screen lacks, or about its order, is
// not about one element, so its path stays the same from run to run and its identity is stable.
const SCREEN_PATH = 'body';

const OUT_OF_REACH_FIX =
  'Check this requirement by hand. usabl reads the elements in the page document, not those inside a shadow root or a frame.';

interface DraftFields {
  elementPath: string;
  node: AxNode | null;
  whatUserExperiences: string;
  why: string;
  fix: string;
  extra?: Record<string, unknown>;
}

function draft(requirement: Requirement, kind: DesignKind, confidence: Draft['confidence'], fields: DraftFields): Draft {
  const evidence: Draft['evidence'] = {};
  if (fields.node !== null) {
    evidence.name = { value: fields.node.name, source: 'ax-tree', fromTree: true };
    evidence.role = { value: fields.node.role, source: 'ax-tree', fromTree: true };
  }
  if (fields.extra !== undefined && Object.keys(fields.extra).length > 0) {
    evidence.extra = fields.extra;
  }
  return {
    rule: `intake:${requirement.id}`,
    layer: DESIGN_CHECK_LAYERS[kind],
    severity: 'moderate',
    evidenceClass: 'deterministic',
    screenId: requirement.surface,
    elementPath: fields.elementPath,
    elementName: fields.node?.name ?? null,
    role: fields.node?.role ?? null,
    whatUserExperiences: fields.whatUserExperiences,
    why: fields.why,
    fix: fields.fix,
    evidence,
    confidence,
  };
}

function named(target: RoleTarget): string {
  return `${ROLE_WORD[target.role]} named "${target.name}"`;
}

// The unconfirmed draft for a search that refused to pick an element. `question` says what is
// unknown, such as 'the button named "Refresh" is at least 24 CSS pixels'.
function refusedDraft(
  requirement: Requirement,
  kind: DesignKind,
  target: RoleTarget,
  resolution: Exclude<TargetResolution, { kind: 'one' } | { kind: 'none' }>,
  question: string,
): Draft {
  if (resolution.kind === 'many') {
    return draft(requirement, kind, 'unverified', {
      elementPath: SCREEN_PATH,
      node: null,
      whatUserExperiences: `Whether ${question} is unknown.`,
      why: `${resolution.count} ${ROLE_PLURAL[target.role]} on this screen are named "${target.name}", so usabl cannot tell which one the design means, and it does not guess.`,
      fix: `Give the ${ROLE_WORD[target.role]} the design means a name no other ${ROLE_WORD[target.role]} on the screen has, or check this requirement by hand.`,
      extra: { matches: resolution.count },
    });
  }
  return draft(requirement, kind, 'unverified', {
    elementPath: SCREEN_PATH,
    node: null,
    whatUserExperiences: `Whether ${question} is unknown.`,
    why: `${resolution.outOfReach} possible ${ROLE_PLURAL[target.role]} sit where usabl cannot read them, such as inside a shadow root or a frame, so the element usabl found may not be the only one, and a missing one may only be out of reach.`,
    fix: OUT_OF_REACH_FIX,
    extra: { found: resolution.found, outOfReach: resolution.outOfReach },
  });
}

async function checkName(requirement: Requirement, assertion: NameAssertion, page: Page): Promise<Draft[]> {
  const target = assertion.target;
  const found = await resolveTarget(page, target);
  if (found.kind === 'one') {
    return [];
  }
  if (found.kind === 'none') {
    return [
      draft(requirement, 'name', 'fail', {
        elementPath: SCREEN_PATH,
        node: null,
        whatUserExperiences: `There is no ${named(target)} on this screen.`,
        why: 'The design names this element, and a screen reader user hears that name.',
        fix: `Give the ${ROLE_WORD[target.role]} the accessible name "${target.name}", or update the requirement if the design changed.`,
      }),
    ];
  }
  return [refusedDraft(requirement, 'name', target, found, `the ${named(target)} is the one the design means`)];
}

function headingLevel(node: AxNode): number | null {
  const level = node.states['level'];
  return typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 6 ? level : null;
}

async function checkHeading(requirement: Requirement, assertion: HeadingAssertion, page: Page): Promise<Draft[]> {
  const target: RoleTarget = { role: 'heading', name: assertion.name };
  const found = await resolveTarget(page, target);
  if (found.kind === 'none') {
    return [
      draft(requirement, 'heading', 'fail', {
        elementPath: SCREEN_PATH,
        node: null,
        whatUserExperiences: `There is no heading named "${assertion.name}" on this screen.`,
        why: 'Screen reader users move through a page by its headings, and the design makes this text a heading.',
        fix: `Make "${assertion.name}" a level ${assertion.level} heading, or update the requirement if the design changed.`,
      }),
    ];
  }
  if (found.kind !== 'one') {
    return [refusedDraft(requirement, 'heading', target, found, `the heading "${assertion.name}" is level ${assertion.level}`)];
  }
  const { match } = found;
  const actual = headingLevel(match.node);
  if (actual === null) {
    return [
      draft(requirement, 'heading', 'unverified', {
        elementPath: match.selector,
        node: match.node,
        whatUserExperiences: `Whether the heading "${assertion.name}" is level ${assertion.level} is unknown.`,
        why: 'The accessibility tree gave this heading no level usabl could read.',
        fix: `Give the heading a level: use an h${assertion.level} element, or aria-level="${assertion.level}" with role="heading".`,
      }),
    ];
  }
  if (actual === assertion.level) {
    return [];
  }
  return [
    draft(requirement, 'heading', 'fail', {
      elementPath: match.selector,
      node: match.node,
      whatUserExperiences: `The heading "${assertion.name}" is level ${actual}. The design says level ${assertion.level}.`,
      why: 'Heading levels tell screen reader users how the page is organized.',
      fix: `Change "${assertion.name}" to a level ${assertion.level} heading.`,
      extra: { expectedLevel: assertion.level, actualLevel: actual },
    }),
  ];
}

// ARIA makes a region or a form a landmark only when it has an accessible name.
function isLandmark(role: LandmarkAssertion['role'], node: AxNode): boolean {
  return role !== 'region' && role !== 'form' ? true : (node.name ?? '').trim() !== '';
}

async function checkLandmark(requirement: Requirement, assertion: LandmarkAssertion, page: Page): Promise<Draft[]> {
  const role = assertion.role;
  const missing = (namedPart: string): Draft =>
    draft(requirement, 'landmark', 'fail', {
      elementPath: SCREEN_PATH,
      node: null,
      whatUserExperiences: `There is no ${ROLE_WORD[role]}${namedPart} on this screen.`,
      why: 'Landmarks let screen reader users jump straight to each part of a page.',
      fix: `Add the ${role} landmark${namedPart} the design shows.`,
    });

  if (assertion.name !== undefined) {
    const target: RoleTarget = { role, name: assertion.name };
    const found = await resolveTarget(page, target);
    if (found.kind === 'one') {
      return [];
    }
    if (found.kind === 'none') {
      return [missing(` named "${assertion.name}"`)];
    }
    return [refusedDraft(requirement, 'landmark', target, found, `the screen has the ${named(target)}`)];
  }

  // With no name, the requirement is that the landmark exists, so any number of them meets it.
  const search = await findByRole(page, role);
  if (search.matches.some((match) => isLandmark(role, match.node))) {
    return [];
  }
  if (search.outOfReach > 0) {
    return [
      draft(requirement, 'landmark', 'unverified', {
        elementPath: SCREEN_PATH,
        node: null,
        whatUserExperiences: `Whether the screen has a ${ROLE_WORD[role]} is unknown.`,
        why: `usabl found none in the page document, and ${search.outOfReach} possible ${ROLE_PLURAL[role]} sit where it cannot read them, such as inside a shadow root or a frame.`,
        fix: OUT_OF_REACH_FIX,
        extra: { outOfReach: search.outOfReach },
      }),
    ];
  }
  return [missing('')];
}

// The most focus stops one walk reads. The walk ends sooner when focus returns to the body or to a
// stop it already reached.
const FOCUS_STOP_CAP = 200;
// How many stops a message lists. The evidence keeps all of them.
const FOCUS_STOPS_SHOWN = 15;
const NO_NAME = '(no name)';

type FocusWalk =
  | { kind: 'walked'; names: string[] }
  | { kind: 'cap' }
  | { kind: 'unreadable'; reason: FocusUnreadable | 'no-path' }
  | { kind: 'node-unreadable'; stop: number };

// One walk from the top of the page. It ends when focus reaches the body, or comes back to a stop it
// already reached, which happens in a focus trap. Either way every stop Tab can reach was read.
async function walkFocus(page: Page): Promise<FocusWalk> {
  await page.focusBody();
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < FOCUS_STOP_CAP; index += 1) {
    await page.tab();
    const unreadable = await page.activeFocusUnreadable();
    if (unreadable !== null) {
      return { kind: 'unreadable', reason: unreadable };
    }
    const path = await page.activePath();
    if (path === '') {
      return { kind: 'unreadable', reason: 'no-path' };
    }
    if (seen.has(path)) {
      return { kind: 'walked', names };
    }
    seen.add(path);
    if (await page.activeElementIs('body')) {
      return { kind: 'walked', names };
    }
    const node = await page.activeNode();
    if (node === null) {
      return { kind: 'node-unreadable', stop: index + 1 };
    }
    names.push((node.name ?? '').trim());
  }
  return { kind: 'cap' };
}

function focusWent(names: readonly string[]): string {
  const shown = names.slice(0, FOCUS_STOPS_SHOWN).map((name) => (name === '' ? NO_NAME : name));
  const more = names.length > FOCUS_STOPS_SHOWN ? `, and ${names.length - FOCUS_STOPS_SHOWN} more` : '';
  return `Focus went: ${shown.length === 0 ? 'nowhere' : shown.join(', ')}${more}.`;
}

function quotedSequence(sequence: readonly string[]): string {
  return sequence.map((name) => `"${name}"`).join(', ');
}

async function checkFocusOrder(requirement: Requirement, assertion: FocusOrderAssertion, page: Page): Promise<Draft[]> {
  const sequence = assertion.sequence.map((name) => name.trim());
  const question = `focus reaches ${quotedSequence(sequence)} in that order`;
  const unconfirmed = (why: string, fix: string, extra: Record<string, unknown> = {}): Draft[] => [
    draft(requirement, 'focus-order', 'unverified', {
      elementPath: SCREEN_PATH,
      node: null,
      whatUserExperiences: `Whether ${question} is unknown.`,
      why,
      fix,
      extra: { expected: sequence, ...extra },
    }),
  ];

  const walk = await walkFocus(page);
  if (walk.kind === 'cap') {
    return unconfirmed(
      `Tab reached ${FOCUS_STOP_CAP} focus stops and focus had not left the page, so the rest of the order was not read.`,
      'Check the page for a focus loop or an unusually long tab sequence, then check this order by hand.',
    );
  }
  if (walk.kind === 'unreadable') {
    const cause =
      walk.reason === 'no-path' ? 'usabl could not compute where focus was' : focusUnreadableCause(walk.reason);
    return unconfirmed(`The walk stopped because ${cause}, so the rest of the order was not read.`, 'Check this order by hand.');
  }
  if (walk.kind === 'node-unreadable') {
    return unconfirmed(
      `The accessibility tree had no node for focus stop ${walk.stop}, so its name could be one of the names in the design.`,
      'Check this order by hand.',
    );
  }

  const names = walk.names;
  const extra = { heard: names };
  // Where each expected name sits in the walk. A name on two stops could mean either stop, and
  // picking one would be a guess.
  const positions = sequence.map((wanted) =>
    names.flatMap((name, index) => (sameName(name, wanted) ? [index] : [])),
  );
  const repeatedAt = positions.findIndex((at) => at.length > 1);
  if (repeatedAt !== -1) {
    return unconfirmed(
      `"${sequence[repeatedAt] ?? ''}" is on ${positions[repeatedAt]?.length ?? 0} focus stops, so usabl cannot tell which one the design means, and it does not guess.`,
      'Give each control in the design a name no other focus stop has, or check this order by hand.',
      extra,
    );
  }

  const fail = (whatUserExperiences: string): Draft[] => [
    draft(requirement, 'focus-order', 'fail', {
      elementPath: SCREEN_PATH,
      node: null,
      whatUserExperiences: `${whatUserExperiences} ${focusWent(names)}`,
      why: 'Keyboard and screen reader users move through controls in focus order, so it must follow the design.',
      fix: 'Reorder the elements in the page source, or remove positive tabindex values, so focus follows the design. If the design changed, update the requirement.',
      extra: { expected: sequence, ...extra },
    }),
  ];

  const missingAt = positions.findIndex((at) => at.length === 0);
  if (missingAt !== -1) {
    const where = missingAt === 0 ? 'The design puts it first.' : `The design puts it after "${sequence[missingAt - 1] ?? ''}".`;
    return fail(`Focus never reached "${sequence[missingAt] ?? ''}". ${where}`);
  }
  for (let index = 1; index < sequence.length; index += 1) {
    if ((positions[index]?.[0] ?? 0) < (positions[index - 1]?.[0] ?? 0)) {
      const earlier = sequence[index - 1] ?? '';
      return fail(`Focus reached "${sequence[index] ?? ''}" before "${earlier}". The design puts "${earlier}" first.`);
    }
  }
  return [];
}

// One decimal, rounded down, so a size below the minimum never prints as the minimum.
function shownSize(pixels: number): number {
  return Math.floor(pixels * 10) / 10;
}

async function checkTargetSize(requirement: Requirement, assertion: TargetSizeAssertion, page: Page): Promise<Draft[]> {
  const target = assertion.target;
  const min = assertion.minCssPx;
  const question = `the ${named(target)} is at least ${min} CSS pixels`;
  const found = await resolveTarget(page, target);
  if (found.kind === 'none') {
    // The name check reports a missing element. Here there is nothing to measure.
    return [
      draft(requirement, 'target-size', 'unverified', {
        elementPath: SCREEN_PATH,
        node: null,
        whatUserExperiences: `Whether ${question} is unknown: no ${ROLE_WORD[target.role]} on this screen has that name.`,
        why: 'The design sets a minimum size for this control, and usabl measures only the element the design names.',
        fix: `Give the ${ROLE_WORD[target.role]} the accessible name "${target.name}", or update the requirement if the design changed.`,
      }),
    ];
  }
  if (found.kind !== 'one') {
    return [refusedDraft(requirement, 'target-size', target, found, question)];
  }
  const { match } = found;
  const box = await page.boundingBox(match.selector);
  if (box === null) {
    return [
      draft(requirement, 'target-size', 'unverified', {
        elementPath: match.selector,
        node: match.node,
        whatUserExperiences: `Whether ${question} is unknown.`,
        why: 'usabl found the element, but could not read its size from the page.',
        fix: 'Check the size of this control by hand.',
      }),
    ];
  }
  // The measured size is compared, never a rounded one: 23.96 pixels is below a 24 pixel minimum.
  if (box.width >= min && box.height >= min) {
    return [];
  }
  return [
    draft(requirement, 'target-size', 'fail', {
      elementPath: match.selector,
      node: match.node,
      whatUserExperiences: `"${target.name}" is ${shownSize(box.width)} by ${shownSize(box.height)} CSS pixels. The design asks for at least ${min}.`,
      why: 'Small targets are hard to hit for people with limited dexterity or on touch screens.',
      fix: `Make the control at least ${min} by ${min} CSS pixels, for example with padding or a minimum size.`,
      extra: { width: box.width, height: box.height, minCssPx: min },
    }),
  ];
}

function isDesignKind(type: Requirement['assertion']['type']): type is DesignKind {
  return Object.hasOwn(DESIGN_CHECK_LAYERS, type);
}

async function runCheck(requirement: Requirement, page: Page): Promise<Draft[]> {
  const assertion = requirement.assertion;
  switch (assertion.type) {
    case 'name':
      return checkName(requirement, assertion, page);
    case 'heading':
      return checkHeading(requirement, assertion, page);
    case 'landmark':
      return checkLandmark(requirement, assertion, page);
    case 'focus-order':
      return checkFocusOrder(requirement, assertion, page);
    case 'target-size':
      return checkTargetSize(requirement, assertion, page);
    default:
      return [];
  }
}

/**
 * The provider for one design requirement, or null for the kinds other providers check: content,
 * flow, and voice have their own, and doc requirements define output artifacts, not checks.
 */
export function designCheckProvider(requirement: Requirement): Provider | null {
  const type = requirement.assertion.type;
  if (!isDesignKind(type)) {
    return null;
  }
  return {
    id: `intake:${requirement.id}`,
    layer: DESIGN_CHECK_LAYERS[type],
    capabilities: ['live'],
    // A focus order is the order of the page as it loaded, as the keyboard walk's is. A probe that
    // opened or dismissed something rewrites it. The other kinds read the page and change nothing.
    ...(type === 'focus-order' ? { requiresPristinePage: true } : {}),
    async run(ctx) {
      // Wrong surface is out of scope for this scan. Coverage wiring decides this later.
      if (ctx.screen.id !== requirement.surface) {
        return [];
      }
      return runCheck(requirement, ctx.page);
    },
  };
}
