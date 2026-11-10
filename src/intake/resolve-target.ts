/**
 * Finds page elements the way a designer names them: by role and accessible name.
 *
 * A fixed CSS selector per role narrows the candidates, and the browser accessibility tree decides,
 * so a match is what assistive technology exposes and not what the markup suggests. Names match
 * exactly after trimming both sides. The selectors are constants: text from a requirement or a
 * design file is only ever compared with what the page exposes, never sent to the page.
 *
 * A wrong guess must become a gap, never a verdict, so this unit refuses to pick an element when it
 * cannot rule out a second match, and says why. When more than one element matches, which one the
 * design means is unknown. When candidates sit where the document query cannot read them, such as
 * inside a shadow root or a frame, the match the query saw may not be the only one, and a missing
 * match may only be out of reach. The document query cannot see every element that has a role
 * either: a role set through ElementInternals, an element in a closed shadow root, or a candidate
 * whose accessibility read came back empty. So the count is checked against the whole
 * accessibility tree of the page, and when the two disagree, or the tree cannot be read, this unit
 * cannot tell. The caller decides what each case means for its check. This unit never decides a
 * verdict.
 */
import type { AxNode, AxTreeNode, Page, RoleTarget, TargetRole } from '../contracts/index.js';

// The elements that can carry each role, by tag or by role attribute. A role attribute can hold
// several tokens, and the browser uses the first one it knows, so a role attribute is matched by
// token (`~=`), and the accessibility tree decides the role. Exported for tests.
export const ROLE_CANDIDATES: Readonly<Record<TargetRole, string>> = {
  button:
    'button, [role~="button"], input[type="button"], input[type="submit"], input[type="reset"], input[type="image"]',
  link: 'a[href], area[href], [role~="link"]',
  heading: 'h1, h2, h3, h4, h5, h6, [role~="heading"]',
  img: 'img, svg, [role~="img"], [role~="image"]',
  textbox:
    'input:not([type]), input[type="text"], input[type="email"], input[type="search"], input[type="password"], input[type="tel"], input[type="url"], textarea, [role~="textbox"], [role~="searchbox"]',
  checkbox: 'input[type="checkbox"], [role~="checkbox"]',
  menuitem: '[role~="menuitem"]',
  tab: '[role~="tab"]',
  main: 'main, [role~="main"]',
  navigation: 'nav, [role~="navigation"]',
  banner: 'header, [role~="banner"]',
  contentinfo: 'footer, [role~="contentinfo"]',
  complementary: 'aside, [role~="complementary"]',
  region: 'section, [role~="region"]',
  search: 'search, [role~="search"]',
  form: 'form, [role~="form"]',
};

// Some roles reach the accessibility tree under another name. Chromium reports an img element as
// "image" and a search input as "searchbox". The ARIA names stay accepted too.
const AX_ROLES: Partial<Record<TargetRole, readonly string[]>> = {
  img: ['img', 'image'],
  textbox: ['textbox', 'searchbox'],
};

export interface TargetMatch {
  // The stable path of the element in the document.
  selector: string;
  node: AxNode;
}

export interface RoleSearch {
  // Every element in the document the accessibility tree gives this role, in document order.
  matches: TargetMatch[];
  // How many candidate elements exist that the document query could not read, such as those inside
  // a shadow root or a frame. Their names and roles are unknown.
  outOfReach: number;
}

// Why the search cannot tell whether its matches are all the matches. 'tree-differs': the whole
// accessibility tree has another number of elements with this role and name than the document
// search read. 'tree-unreadable': the tree was larger than usabl reads, in time or in nodes.
export type CannotTellReason = 'tree-differs' | 'tree-unreadable';

export type TargetResolution =
  | { kind: 'one'; match: TargetMatch }
  | { kind: 'none' }
  | { kind: 'many'; count: number }
  | { kind: 'out-of-reach'; found: number; outOfReach: number }
  | { kind: 'cannot-tell'; reason: CannotTellReason; found: number; inTree: number | null };

/** Whether an accessible name is the name a requirement states, after trimming both. */
export function sameName(actual: string | null, wanted: string): boolean {
  return actual !== null && actual.trim() === wanted.trim();
}

function roleMatches(role: TargetRole, axRole: string | null): boolean {
  if (axRole === null) {
    return false;
  }
  return (AX_ROLES[role] ?? [role]).includes(axRole);
}

export async function findByRole(page: Page, role: TargetRole): Promise<RoleSearch> {
  const selector = ROLE_CANDIDATES[role];
  const refs = await page.queryAll(selector);
  const matches: TargetMatch[] = [];
  for (const ref of refs) {
    const node = await page.axAt(ref.selector);
    if (node !== null && roleMatches(role, node.role)) {
      matches.push({ selector: ref.selector, node });
    }
  }
  // countEverywhere looks into open shadow roots and every frame, which the document query does
  // not. Any candidate it counts beyond the document's own is one this search could not read.
  const everywhere = await page.countEverywhere(selector);
  return { matches, outOfReach: Math.max(0, everywhere - refs.length) };
}

/**
 * The nodes of the page's whole accessibility tree that assistive technology perceives with a
 * role, or null when the tree could not be read. The browser builds the tree from every role
 * source, closed shadow roots included. It does not cover child frames, which countEverywhere does.
 */
export async function perceivedWithRole(page: Page, role: TargetRole): Promise<AxTreeNode[] | null> {
  const tree = await page.fullAxTree();
  if (tree.kind !== 'tree') {
    return null;
  }
  return tree.nodes.filter((node) => !node.ignored && roleMatches(role, node.role));
}

export async function resolveTarget(page: Page, target: RoleTarget): Promise<TargetResolution> {
  const search = await findByRole(page, target.role);
  const named = search.matches.filter((match) => sameName(match.node.name, target.name));
  if (named.length > 1) {
    return { kind: 'many', count: named.length };
  }
  if (search.outOfReach > 0) {
    return { kind: 'out-of-reach', found: named.length, outOfReach: search.outOfReach };
  }
  const perceived = await perceivedWithRole(page, target.role);
  if (perceived === null) {
    return { kind: 'cannot-tell', reason: 'tree-unreadable', found: named.length, inTree: null };
  }
  const inTree = perceived.filter((node) => sameName(node.name, target.name)).length;
  // The tree sees every element with the role and name. When it has two, there are two elements,
  // whatever the document search read.
  if (inTree > 1) {
    return { kind: 'many', count: inTree };
  }
  if (inTree !== named.length) {
    return { kind: 'cannot-tell', reason: 'tree-differs', found: named.length, inTree };
  }
  const [only] = named;
  return only === undefined ? { kind: 'none' } : { kind: 'one', match: only };
}
