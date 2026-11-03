/// <reference lib="dom" />
/**
 * Runs axe-core in a CDP isolated world in every frame of a page, so page script cannot change
 * what axe reads or what it reports.
 *
 * axe used to run in the page's own world. Page script shares that world, so it could patch the
 * DOM prototypes axe reads through, or define a `window.axe` getter, and change axe's selectors and
 * results. A page that made one button's id read as another's had two findings named by one
 * selector, and a new barrier in one table row read as the carried barrier of another. Here axe is
 * loaded into a world of its own in each frame. Page script shares the DOM with it but not its
 * globals or prototypes.
 *
 * The frame walk is the one axe's own Playwright runner does: axe.runPartial in each frame, child
 * frames found through axe's frame contexts, and axe.finishRun over every partial result. finishRun
 * runs in the top frame's world, so no blank page is opened. A child frame axe cannot be loaded
 * into or run in is never dropped: it is reported as an unchecked frame, named by its origin, with
 * the reason. The caller turns each one into a coverage gap.
 *
 * This unit never mints a verdict. It returns what axe returned, and the frames it could not check.
 */
import axe from 'axe-core';
import type { CDPSession, Page as PwPage } from 'playwright';

/** The world axe runs in, in every frame. */
export const AXE_WORLD = 'usabl-axe';

// How long one step in one frame may take: loading axe, reading the frame's own frames, running
// axe, or finishing the run. axe's own runner allowed a child frame one second to load axe and
// silently dropped a frame that took longer, which a busy machine reaches. A step that runs out
// this budget is disclosed, so the budget only has to bound a frame that never answers. It is far
// above what a large page measured under load, so load alone does not decide it.
export const AXE_STEP_TIMEOUT_MS = 60_000;

// How long closing a frame session may take. See AxeWorldRun.close.
const DETACH_TIMEOUT_MS = 5_000;

/** A frame axe could not check: its origin, and why. Both are for a reader of the gap. */
export interface UncheckedFrame {
  origin: string;
  why: string;
}

export interface AxeWorldResult {
  // The axe results object, untyped: it is read by the mapping in real.ts, defensively.
  results: unknown;
  // In document order of the frames axe found. Empty when every frame was checked.
  uncheckedFrames: UncheckedFrame[];
}

export interface AxeWorldOptions {
  // Only tests set this, to reach the timeout path without waiting the full budget.
  stepTimeoutMs?: number;
}

// One frame, as CDP addresses it: the session that owns it and its frame id.
interface FrameTarget {
  session: CDPSession;
  frameId: string;
  url: string;
}

// A frame-level failure. The message says what failed, in words for a reader of the gap.
class FrameError extends Error {}

function getProp(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  return Reflect.get(value, key);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}

/**
 * Rejects when the step outlasts the budget. The step itself cannot be cancelled, so it is left
 * to settle on its own, and its later failure is swallowed rather than left unhandled.
 */
async function withTimeout<T>(step: Promise<T>, ms: number, what: string): Promise<T> {
  step.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new FrameError(`${what} took longer than ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([step, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls a function declaration in a world. Arguments are passed as CDP values, never spliced in
 * as code. A function that throws, or a promise that rejects, becomes a FrameError.
 */
async function callIn(
  target: FrameTarget,
  contextId: number,
  functionDeclaration: string,
  args: readonly unknown[],
  returnByValue: boolean,
): Promise<unknown> {
  const called: unknown = await target.session.send('Runtime.callFunctionOn', {
    functionDeclaration,
    executionContextId: contextId,
    arguments: args.map((value) => ({ value })),
    returnByValue,
    awaitPromise: true,
    objectGroup: AXE_WORLD,
  });
  const exception = getProp(called, 'exceptionDetails');
  if (exception !== undefined) {
    const description = readString(getProp(getProp(exception, 'exception'), 'description'));
    throw new FrameError(firstLine(description ?? readString(getProp(exception, 'text')) ?? 'unknown error'));
  }
  return getProp(called, 'result');
}

async function createWorld(target: FrameTarget): Promise<number> {
  const world: unknown = await target.session.send('Page.createIsolatedWorld', {
    frameId: target.frameId,
    worldName: AXE_WORLD,
  });
  const contextId = readNumber(getProp(world, 'executionContextId'));
  if (contextId === null) {
    throw new FrameError('the browser did not create a world for axe in it');
  }
  return contextId;
}

async function loadAxe(target: FrameTarget, contextId: number): Promise<void> {
  // A fresh copy for every run. A copy left from a run that timed out still holds its running
  // flag, and axe refuses to start while it is set.
  const loaded: unknown = await target.session.send('Runtime.evaluate', {
    expression: `${axe.source};\ntypeof axe.runPartial === 'function'`,
    contextId,
    returnByValue: true,
  });
  if (getProp(loaded, 'exceptionDetails') !== undefined || getProp(getProp(loaded, 'result'), 'value') !== true) {
    throw new FrameError('axe did not load in it');
  }
}

// Every custom element axe will visit: the document and every open shadow root inside it. axe
// reads internals only for custom elements, and only in the trees it flattens, which are these.
const CUSTOM_ELEMENTS_FUNCTION = `function () {
  const found = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll('*')) {
      if (element.localName.includes('-')) found.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  return found;
}`;

// The ARIA states the isolated run can hand axe, by the ElementInternals property axe reads for
// each. They are the states axe's aria-required-attr rule asks for: aria-checked, aria-expanded,
// aria-level, and aria-valuenow. axe's ariaAttrs standard names the property for each attribute,
// and axe reads it from the internals object when the element has no attribute.
const CARRIED_STATES = ['ariaChecked', 'ariaExpanded', 'ariaLevel', 'ariaValueNow'] as const;

// Hands axe the semantics a custom element set through ElementInternals. axe finds internals by
// reading page-world properties such as `_internals`, which this world cannot see, and it reads
// `globalThis._elementInternals` first. Each record carries what the browser's accessibility tree
// computed for the element, so axe sees the role the browser exposes. A role axe does not know is
// left out, as it would be from real internals.
export const SET_INTERNALS_FUNCTION = `function (records) {
  const map = new WeakMap();
  this.forEach((element, index) => {
    const record = records[index];
    if (record === null || typeof record !== 'object') return;
    const internals = {};
    if (typeof record.role === 'string' && axe.commons.aria.isValidRole(record.role)) internals.role = record.role;
    if (typeof record.ariaLabel === 'string') internals.ariaLabel = record.ariaLabel;
    for (const name of ${JSON.stringify(CARRIED_STATES)}) {
      if (typeof record[name] === 'string') internals[name] = record[name];
    }
    if (Object.keys(internals).length > 0) map.set(element, internals);
  });
  globalThis._elementInternals = map;
}`;

// Whether a frame element is sandboxed without allow-scripts.
const SANDBOXED_WITHOUT_SCRIPTS_FUNCTION = `function () {
  return this.hasAttribute('sandbox') && !(this.sandbox && this.sandbox.contains('allow-scripts'));
}`;

// Chromium names a few roles differently from ARIA. Only the ones a custom element can take
// through internals are listed.
const CHROMIUM_ROLE_TO_ARIA: Record<string, string> = { image: 'img' };

type InternalsRecord = { role?: string; ariaLabel?: string } & Partial<Record<(typeof CARRIED_STATES)[number], string>>;

// The value of one named property of an accessibility node, or undefined.
function axProperty(axNode: unknown, name: string): unknown {
  const properties = getProp(axNode, 'properties');
  if (!Array.isArray(properties)) {
    return undefined;
  }
  const found: unknown = properties.find((property: unknown) => getProp(property, 'name') === name);
  return getProp(getProp(found, 'value'), 'value');
}

// The value Chromium reports for a range role that set no aria-valuenow, at the single precision it
// computes in, or null for a role this does not know. ARIA 1.1 defaults: a slider or scrollbar sits
// halfway between its minimum and maximum, a separator at 50, and a meter at its minimum. The tree
// reports the minimum and maximum, which default to 0 and 100.
function defaultValueNow(role: string | null, axNode: unknown): number | null {
  const min = readNumber(axProperty(axNode, 'valuemin')) ?? 0;
  const max = readNumber(axProperty(axNode, 'valuemax')) ?? 100;
  switch (role) {
    case 'slider':
    case 'scrollbar':
      return Math.fround(Math.fround(Math.fround(min) + Math.fround(max)) / 2);
    case 'separator':
    case 'splitter':
      return 50;
    case 'meter':
      return Math.fround(min);
    default:
      return null;
  }
}

function attributesOf(flat: unknown): Map<string, string> {
  const attributes = new Map<string, string>();
  if (!Array.isArray(flat)) {
    return attributes;
  }
  for (let index = 0; index + 1 < flat.length; index += 2) {
    const name: unknown = flat[index];
    const value: unknown = flat[index + 1];
    if (typeof name === 'string' && typeof value === 'string') {
      attributes.set(name, value);
    }
  }
  return attributes;
}

/**
 * The semantics one custom element shows in the accessibility tree that its attributes do not
 * explain, or null. A custom element with no internals is exposed as generic or not at all, so a
 * role here came from internals. A name read from aria-label on an element with no aria-label
 * attribute came from internals too.
 *
 * The tree reports a default value for some states whether or not the element set one, such as
 * unchecked for a checkbox. So a state is carried only when the element has no attribute for it
 * and the tree reports a value the role's default cannot explain, which only internals can set:
 * - `checked` of `true` or `mixed`, as `ariaChecked`. `false` is the default and is dropped.
 * - `expanded` of true, as `ariaExpanded` `'true'`. false is the default and is dropped.
 * - On a heading, a `level` other than 2, as `ariaLevel`. 2 is the default and is dropped. A level
 *   on any other role is dropped, because the browser computes it from position, as for a tree item.
 * - On a slider, scrollbar, separator, or meter, a current value other than the role's default
 *   (see defaultValueNow), as `ariaValueNow`. The tree reports it as the node's numeric `value`.
 *   A value on any other role is dropped, and so is a text value.
 * An element that set a state to its default value is still reported as missing it. That can be a
 * false barrier, never a missed one.
 */
export function internalsRecord(axNode: unknown, attributes: Map<string, string>): InternalsRecord | null {
  if (axNode === undefined || getProp(axNode, 'ignored') === true) {
    return null;
  }
  const record: InternalsRecord = {};
  const role = readString(getProp(getProp(axNode, 'role'), 'value'));
  if (!attributes.has('role') && role !== null && role !== 'generic' && role !== 'none') {
    record.role = CHROMIUM_ROLE_TO_ARIA[role] ?? role;
  }
  const sources = getProp(getProp(axNode, 'name'), 'sources');
  if (!attributes.has('aria-label') && Array.isArray(sources)) {
    for (const source of sources) {
      if (getProp(source, 'type') === 'attribute' && getProp(source, 'attribute') === 'aria-label') {
        const value = readString(getProp(getProp(source, 'attributeValue'), 'value'));
        if (value !== null) {
          record.ariaLabel = value;
        }
      }
    }
  }
  const checked = readString(axProperty(axNode, 'checked'));
  if (!attributes.has('aria-checked') && (checked === 'true' || checked === 'mixed')) {
    record.ariaChecked = checked;
  }
  if (!attributes.has('aria-expanded') && axProperty(axNode, 'expanded') === true) {
    record.ariaExpanded = 'true';
  }
  const level = readNumber(axProperty(axNode, 'level'));
  if (!attributes.has('aria-level') && role === 'heading' && level !== null && Number.isInteger(level) && level !== 2) {
    record.ariaLevel = String(level);
  }
  const valueNow = readNumber(getProp(getProp(axNode, 'value'), 'value'));
  const defaultNow = defaultValueNow(role, axNode);
  if (!attributes.has('aria-valuenow') && valueNow !== null && defaultNow !== null && Math.fround(valueNow) !== defaultNow) {
    record.ariaValueNow = String(valueNow);
  }
  return Object.keys(record).length === 0 ? null : record;
}

async function fillInternals(target: FrameTarget, contextId: number, isTop: boolean): Promise<void> {
  const list = (await callIn(target, contextId, CUSTOM_ELEMENTS_FUNCTION, [], false)) as unknown;
  const listId = readString(getProp(list, 'objectId'));
  if (listId === null) {
    return;
  }
  const properties: unknown = await target.session.send('Runtime.getProperties', { objectId: listId, ownProperties: true });
  const entries = getProp(properties, 'result');
  const elementIds: string[] = [];
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const name = readString(getProp(entry, 'name'));
      const objectId = readString(getProp(getProp(entry, 'value'), 'objectId'));
      if (name !== null && /^\d+$/.test(name) && objectId !== null) {
        elementIds[Number(name)] = objectId;
      }
    }
  }
  if (elementIds.length === 0) {
    return;
  }
  // One tree read for the frame, rather than one per element.
  const tree: unknown = await target.session.send(
    'Accessibility.getFullAXTree',
    isTop ? {} : { frameId: target.frameId },
  );
  const byBackendId = new Map<number, unknown>();
  const nodes = getProp(tree, 'nodes');
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const backendId = readNumber(getProp(node, 'backendDOMNodeId'));
      if (backendId !== null) {
        byBackendId.set(backendId, node);
      }
    }
  }
  const records = await Promise.all(
    Array.from(elementIds, async (objectId): Promise<InternalsRecord | null> => {
      if (objectId === undefined) {
        return null;
      }
      const described: unknown = await target.session.send('DOM.describeNode', { objectId });
      const node = getProp(described, 'node');
      const backendId = readNumber(getProp(node, 'backendNodeId'));
      if (backendId === null) {
        return null;
      }
      return internalsRecord(byBackendId.get(backendId), attributesOf(getProp(node, 'attributes')));
    }),
  );
  await target.session.send('Runtime.callFunctionOn', {
    objectId: listId,
    functionDeclaration: SET_INTERNALS_FUNCTION,
    arguments: [{ value: records }],
  });
}

// The origin of a frame address, for a reader of the gap. Never a path, a query, or a fragment.
export function frameOrigin(url: string): string {
  if (url === '' || url.startsWith('about:')) {
    return url === '' ? 'an unnamed frame' : url.split(/[?#]/)[0] ?? url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'null') {
      return parsed.origin;
    }
    return `a ${parsed.protocol} frame`;
  } catch {
    return 'a frame with an address usabl could not read';
  }
}

function findFrameUrl(tree: unknown, frameId: string): string | null {
  const frame = getProp(tree, 'frame');
  if (readString(getProp(frame, 'id')) === frameId) {
    return readString(getProp(frame, 'url'));
  }
  const children = getProp(tree, 'childFrames');
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findFrameUrl(child, frameId);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * One run over one page. It holds the sessions it opened for frames in other processes, so each is
 * opened once and all are closed at the end.
 */
class AxeWorldRun {
  private readonly frameSessions = new Map<string, CDPSession>();
  private readonly opened: CDPSession[] = [];
  readonly uncheckedFrames: UncheckedFrame[] = [];

  constructor(
    private readonly pw: PwPage,
    private readonly runOptions: Record<string, unknown>,
    private readonly stepTimeoutMs: number,
  ) {}

  private step<T>(promise: Promise<T>, what: string): Promise<T> {
    return withTimeout(promise, this.stepTimeoutMs, what);
  }

  /**
   * Loads axe into a frame's world and fills in internals, and returns the world. Every step is
   * bounded, so a frame that never answers fails here rather than holding the scan.
   */
  async prepare(target: FrameTarget, isTop: boolean): Promise<number> {
    const contextId = await this.step(createWorld(target), 'creating a world for axe');
    await this.step(loadAxe(target, contextId), 'loading axe');
    await this.step(fillInternals(target, contextId, isTop), 'reading the semantics custom elements set');
    return contextId;
  }

  /**
   * The partial results of one frame and every frame under it, in the order finishRun expects:
   * the frame first, then each child frame's own list. A child frame that fails is one null, and
   * nothing under it is visited, which is the shape finishRun reads a missing frame from.
   */
  async partials(target: FrameTarget, contextId: number, context: unknown): Promise<unknown[]> {
    const frameContexts = getProp(
      await this.step(
        callIn(target, contextId, 'function (context) { return axe.utils.getFrameContexts(context); }', [context], true),
        "reading the frame's own frames",
      ),
      'value',
    );
    const partial = getProp(
      await this.step(
        callIn(
          target,
          contextId,
          'function (context, options) { return axe.runPartial(context, options); }',
          [context, this.runOptions],
          true,
        ),
        'running axe',
      ),
      'value',
    );
    const all: unknown[] = [partial];
    if (!Array.isArray(frameContexts)) {
      return all;
    }
    for (const frameContext of frameContexts) {
      all.push(...(await this.childPartials(target, contextId, frameContext)));
    }
    return all;
  }

  private async childPartials(parent: FrameTarget, parentContextId: number, frameContext: unknown): Promise<unknown[]> {
    // Filled in as soon as the frame's address is known, so a frame that fails later is still named.
    const seen = { url: '' };
    try {
      const child = await this.childTarget(parent, parentContextId, getProp(frameContext, 'frameSelector'), seen);
      const contextId = await this.prepare(child, false);
      return await this.partials(child, contextId, getProp(frameContext, 'frameContext'));
    } catch (error) {
      const why = error instanceof FrameError ? error.message : `axe failed in it: ${firstLine(error)}`;
      this.uncheckedFrames.push({ origin: frameOrigin(seen.url), why });
      return [null];
    }
  }

  /**
   * The frame an axe frame selector names. A frame in the parent's process is reached through the
   * parent's session. A frame in another process has a session of its own, found by its frame id.
   */
  private async childTarget(
    parent: FrameTarget,
    parentContextId: number,
    frameSelector: unknown,
    seen: { url: string },
  ): Promise<FrameTarget> {
    const element = await this.step(
      callIn(parent, parentContextId, 'function (selector) { return axe.utils.shadowSelect(selector); }', [frameSelector], false),
      'finding the frame element',
    );
    const objectId = readString(getProp(element, 'objectId'));
    if (objectId === null) {
      throw new FrameError('its frame element was gone before axe reached it');
    }
    const described: unknown = await this.step(parent.session.send('DOM.describeNode', { objectId }), 'reading the frame element');
    const frameId = readString(getProp(getProp(described, 'node'), 'frameId'));
    if (frameId === null) {
      throw new FrameError('its frame element holds no frame');
    }
    const tree: unknown = await this.step(parent.session.send('Page.getFrameTree'), 'reading the frame tree');
    const treeUrl = findFrameUrl(getProp(tree, 'frameTree'), frameId) ?? '';
    seen.url = treeUrl;
    // axe waits on timers, and no timer runs in a frame sandboxed without scripts, not even in
    // usabl's world. Such a frame is named at once rather than after the whole step budget.
    const sandboxed = getProp(
      await this.step(
        parent.session.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: SANDBOXED_WITHOUT_SCRIPTS_FUNCTION,
          returnByValue: true,
        }),
        'reading the frame element',
      ),
      'result',
    );
    if (getProp(sandboxed, 'value') === true) {
      throw new FrameError('it is sandboxed without scripts, so axe cannot run in it');
    }
    // A frame in the parent's process takes a world through the parent's session. One in another
    // process does not: the parent's process does not hold its document.
    const inProcess: FrameTarget = { session: parent.session, frameId, url: treeUrl };
    const inParent = await this.step(
      createWorld(inProcess).then(
        () => true,
        () => false,
      ),
      'creating a world for axe',
    );
    if (inParent) {
      return inProcess;
    }
    const session = await this.step(this.sessionFor(frameId), 'finding the frame in another process');
    if (session === null) {
      throw new FrameError('it runs in another process and usabl found no session for it');
    }
    const info: unknown = await this.step(session.send('Target.getTargetInfo'), 'reading the frame address');
    seen.url = readString(getProp(getProp(info, 'targetInfo'), 'url')) ?? treeUrl;
    return { session, frameId, url: seen.url };
  }

  // The session of a frame in another process. Its target id is its frame id. The browser answers
  // this, not the frame's own process, so a frame that hangs cannot hold it.
  private async sessionFor(frameId: string): Promise<CDPSession | null> {
    const known = this.frameSessions.get(frameId);
    if (known !== undefined) {
      return known;
    }
    for (const frame of this.pw.frames()) {
      if (frame === this.pw.mainFrame()) {
        continue;
      }
      let session: CDPSession;
      try {
        session = await this.pw.context().newCDPSession(frame);
      } catch {
        // A frame in its parent's process has no session of its own.
        continue;
      }
      this.opened.push(session);
      const info: unknown = await session.send('Target.getTargetInfo').catch(() => undefined);
      const targetId = readString(getProp(getProp(info, 'targetInfo'), 'targetId'));
      if (targetId !== null) {
        this.frameSessions.set(targetId, session);
      }
      if (targetId === frameId) {
        return session;
      }
    }
    return null;
  }

  // Detaching from a frame whose process stopped answering can wait forever, so each detach is
  // bounded. A session left behind goes with the frame or the page.
  async close(): Promise<void> {
    await Promise.all(
      this.opened.map((session) =>
        withTimeout(session.detach(), DETACH_TIMEOUT_MS, 'detaching from a frame').catch(() => undefined),
      ),
    );
  }
}

/**
 * Runs axe in an isolated world in every frame of the page and returns its results and the frames
 * it could not check. A failure in the top frame throws: there is no result to report, and the
 * caller discloses the whole run as a gap.
 */
export async function runAxeInIsolatedWorld(
  pw: PwPage,
  cdp: CDPSession,
  runOptions: Record<string, unknown>,
  options: AxeWorldOptions = {},
): Promise<AxeWorldResult> {
  const stepTimeoutMs = options.stepTimeoutMs ?? AXE_STEP_TIMEOUT_MS;
  const run = new AxeWorldRun(pw, runOptions, stepTimeoutMs);
  try {
    const tree: unknown = await withTimeout(cdp.send('Page.getFrameTree'), stepTimeoutMs, 'reading the frame tree');
    const frame = getProp(getProp(tree, 'frameTree'), 'frame');
    const frameId = readString(getProp(frame, 'id'));
    if (frameId === null) {
      throw new Error('the page has no main frame to run axe in');
    }
    const top: FrameTarget = { session: cdp, frameId, url: readString(getProp(frame, 'url')) ?? '' };
    // The same context axe's own runner passes: the whole document, nothing excluded.
    const context = { exclude: [], include: [] };
    let partials: unknown[];
    let contextId: number;
    try {
      contextId = await run.prepare(top, true);
      partials = await run.partials(top, contextId, context);
    } catch (error) {
      throw new Error(`axe could not run on the page: ${firstLine(error)}`);
    }
    const finished = await withTimeout(
      callIn(
        top,
        contextId,
        'function (partials, options) { return axe.finishRun(partials, options); }',
        [partials, runOptions],
        true,
      ),
      stepTimeoutMs,
      'finishing the axe run',
    ).catch((error: unknown) => {
      throw new Error(`axe could not finish its run on the page: ${firstLine(error)}`);
    });
    return { results: getProp(finished, 'value'), uncheckedFrames: run.uncheckedFrames };
  } finally {
    await run.close();
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: AXE_WORLD }).catch(() => undefined);
  }
}
