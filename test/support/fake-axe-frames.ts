/**
 * A stand-in for a Playwright page and its CDP sessions, enough for runAxeInIsolatedWorld to walk a
 * frame tree without a browser. Each frame belongs to a process. A frame whose parent runs in
 * another process, and the top frame, is a local root: it has a CDP session of its own, as Chrome
 * gives it a target of its own. A session's frame tree holds its local root and every frame under
 * it in the same local root, never a frame in another local root.
 *
 * The axe calls are answered from the model: axe finds the frames its flat tree holds (an iframe
 * that is not hidden and not in a closed shadow root), runPartial lists the same frames, and
 * finishRun returns an empty result. Hooks let a test change the model mid-run.
 *
 * Test-only. Nothing here ships in the package.
 */
import type { CDPSession, Page as PwPage } from 'playwright';

export interface FakeFrame {
  id: string;
  url: string;
  process: string;
  parent?: string;
  // How the frame is held: an iframe axe can find, an iframe in a closed shadow root, or a
  // document in an object or embed element. Defaults to an iframe.
  owner?: 'iframe' | 'closed-shadow-iframe' | 'object' | 'embed';
  // Hidden from assistive technology, so axe skips it and the tree marks its owner ignored.
  hidden?: boolean;
  // No CDP session can be opened for it, though it is a local root.
  noSession?: boolean;
  // What runPartial returns in it, when not the default.
  partial?: () => unknown;
  // Its process never answers: every call on its session waits forever, except the ones the
  // browser answers, and a second session for it is never opened.
  hangs?: boolean;
}

export interface FakeHooks {
  // Called before each axe call in a frame, with the call's name.
  beforeCall?: (frame: FakeFrame, call: string, model: FakeModel) => void;
  // What getFrameContexts returns in a frame, when not the default. `read` counts from 1.
  frameContexts?: (frame: FakeFrame, read: number, model: FakeModel) => unknown;
  // What finishRun returns, when not an empty result.
  finish?: () => unknown;
  // What the internals install returns, when not success.
  installFails?: (frame: FakeFrame) => boolean;
  // Custom elements in a frame, so the internals install runs.
  customElements?: (frame: FakeFrame) => number;
}

export class FakeModel {
  readonly frames = new Map<string, FakeFrame>();
  readonly calls: string[] = [];
  readonly detached: string[] = [];
  readonly opened: string[] = [];
  private nextContext = 1;
  readonly contexts = new Map<number, string>();
  readonly runs = new Map<string, { partial: unknown; elements: Array<string | null> }>();
  private readonly reads = new Map<string, number>();

  constructor(
    frames: FakeFrame[],
    readonly hooks: FakeHooks = {},
  ) {
    for (const frame of frames) this.frames.set(frame.id, frame);
  }

  remove(id: string): void {
    for (const child of this.childrenOf(id)) this.remove(child.id);
    this.frames.delete(id);
  }

  // A navigation: every world in the frame is gone.
  navigate(id: string): void {
    for (const [context, frameId] of this.contexts) {
      if (frameId === id) this.contexts.delete(context);
    }
  }

  top(): FakeFrame {
    const top = [...this.frames.values()].find((frame) => frame.parent === undefined);
    if (top === undefined) throw new Error('the model has no top frame');
    return top;
  }

  childrenOf(id: string): FakeFrame[] {
    return [...this.frames.values()].filter((frame) => frame.parent === id);
  }

  localRoot(frame: FakeFrame): FakeFrame {
    const parent = frame.parent === undefined ? undefined : this.frames.get(frame.parent);
    if (parent === undefined || parent.process !== frame.process) return frame;
    return this.localRoot(parent);
  }

  // The frames axe finds in a frame: iframes in its flat tree that are not hidden.
  axeChildren(id: string): FakeFrame[] {
    return this.childrenOf(id).filter((frame) => (frame.owner ?? 'iframe') === 'iframe' && frame.hidden !== true);
  }

  newContext(frameId: string): number {
    const context = this.nextContext;
    this.nextContext += 1;
    this.contexts.set(context, frameId);
    return context;
  }

  // A frame's owner element, as a backend node id, and back.
  ownerNode(frameId: string): number {
    return 1000 + [...this.frames.keys()].indexOf(frameId);
  }

  frameOfOwner(backendNodeId: unknown): FakeFrame | undefined {
    const id = [...this.frames.keys()][Number(backendNodeId) - 1000];
    return id === undefined ? undefined : this.frames.get(id);
  }

  read(frameId: string): number {
    const count = (this.reads.get(frameId) ?? 0) + 1;
    this.reads.set(frameId, count);
    return count;
  }
}

const selectorOf = (id: string): string => `#${id}`;

function frameTreeOf(model: FakeModel, root: FakeFrame): unknown {
  const local = (frame: FakeFrame): unknown => ({
    frame: { id: frame.id, url: frame.url, ...(frame.parent === undefined ? {} : { parentId: frame.parent }) },
    childFrames: model
      .childrenOf(frame.id)
      .filter((child) => model.localRoot(child) === root)
      .map(local),
  });
  return { frameTree: local(root) };
}

class FakeSession {
  constructor(
    private readonly model: FakeModel,
    readonly rootId: string,
  ) {}

  private root(): FakeFrame {
    const root = this.model.frames.get(this.rootId);
    if (root === undefined) throw new Error('Target closed');
    return root;
  }

  private frameOfContext(contextId: unknown): FakeFrame {
    const frameId = this.model.contexts.get(Number(contextId));
    const frame = frameId === undefined ? undefined : this.model.frames.get(frameId);
    if (frame === undefined) throw new Error('Execution context was destroyed.');
    return frame;
  }

  private axeCall(frame: FakeFrame, call: string): void {
    this.model.calls.push(`${frame.id}:${call}`);
    this.model.hooks.beforeCall?.(frame, call, this.model);
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await Promise.resolve();
    const model = this.model;
    if (model.frames.get(this.rootId)?.hangs === true && method !== 'Target.getTargetInfo') {
      return new Promise(() => undefined);
    }
    switch (method) {
      case 'Page.getFrameTree':
        return frameTreeOf(model, this.root());
      case 'Page.createIsolatedWorld': {
        const frame = model.frames.get(String(params.frameId));
        if (frame === undefined || model.localRoot(frame).id !== this.rootId) throw new Error('No frame for given id found');
        return { executionContextId: model.newContext(frame.id) };
      }
      case 'Runtime.evaluate':
        this.frameOfContext(params.contextId);
        return { result: { type: 'boolean', value: true } };
      case 'Runtime.callFunctionOn':
        return this.callFunctionOn(params);
      case 'Runtime.getProperties': {
        const elementsOf = String(params.objectId).match(/^(ran:.*):elements$/);
        if (elementsOf !== null) {
          const elements = model.runs.get(elementsOf[1] ?? '')?.elements ?? [];
          return { result: elements.map((id, index) => ({ name: String(index), value: id === null ? { type: 'object', subtype: 'null', value: null } : { type: 'object', objectId: id } })) };
        }
        const frameId = String(params.objectId).replace(/^elements:/, '');
        const frame = model.frames.get(frameId);
        const count = frame === undefined ? 0 : (model.hooks.customElements?.(frame) ?? 0);
        return { result: Array.from({ length: count }, (_, index) => ({ name: String(index), value: { objectId: `element:${frameId}:${index}` } })) };
      }
      case 'Accessibility.getFullAXTree':
        return { nodes: [] };
      case 'DOM.describeNode': {
        const objectId = String(params.objectId ?? '');
        if (objectId.startsWith('frame-element:')) {
          const id = objectId.replace(/^frame-element:/, '');
          // A removed frame element holds no frame.
          return { node: { nodeName: 'IFRAME', ...(model.frames.has(id) ? { frameId: id } : {}) } };
        }
        if (objectId.startsWith('element:')) {
          return { node: { backendNodeId: 1, attributes: [] } };
        }
        const owner = model.frameOfOwner(params.backendNodeId);
        return { node: { nodeName: (owner?.owner ?? 'iframe').replace('closed-shadow-', '').toUpperCase() } };
      }
      case 'DOM.getFrameOwner': {
        const frame = model.frames.get(String(params.frameId));
        if (frame === undefined) throw new Error('Frame with the given id was not found.');
        return { backendNodeId: model.ownerNode(frame.id) };
      }
      case 'Accessibility.getPartialAXTree': {
        const frame = model.frameOfOwner(params.backendNodeId);
        return { nodes: [{ backendDOMNodeId: params.backendNodeId, ignored: frame?.hidden === true }] };
      }
      case 'Target.getTargetInfo': {
        const root = this.root();
        return { targetInfo: { targetId: root.id, url: root.url } };
      }
      case 'Runtime.releaseObjectGroup':
        return {};
      default:
        throw new Error(`the fake does not answer ${method}`);
    }
  }

  private callFunctionOn(params: Record<string, unknown>): unknown {
    const model = this.model;
    const declaration = String(params.functionDeclaration);
    const objectId = params.objectId === undefined ? undefined : String(params.objectId);
    if (objectId !== undefined) {
      if (objectId.startsWith('ran:')) {
        const ran = model.runs.get(objectId);
        if (declaration.includes('this.partial')) return { result: { type: 'object', value: ran?.partial } };
        if (declaration.includes('this.elements')) return { result: { type: 'object', objectId: `${objectId}:elements` } };
      }
      if (objectId.startsWith('frame-element:')) {
        return { result: { type: 'boolean', value: false } };
      }
      const frame = model.frames.get(objectId.replace(/^elements:/, ''));
      if (declaration.includes('getComputedStyle')) {
        const count = frame === undefined ? 0 : (model.hooks.customElements?.(frame) ?? 0);
        const plain = { display: 'inline', content: 'normal', focusable: false, minimumRoleAttribute: false, relations: false, focusgroup: false, scrollMarker: false };
        return { result: { type: 'object', value: Array.from({ length: count }, () => plain) } };
      }
      if (declaration.includes('_elementInternals')) {
        if (frame !== undefined && model.hooks.installFails?.(frame) === true) {
          return { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: install failed' } } };
        }
        return { result: { type: 'undefined' } };
      }
      throw new Error('the fake does not answer this call on an object');
    }
    const frame = this.frameOfContext(params.executionContextId);
    if (declaration.includes("localName.includes('-')")) {
      return { result: { type: 'object', objectId: `elements:${frame.id}` } };
    }
    if (declaration.includes('getFrameContexts')) {
      this.axeCall(frame, 'getFrameContexts');
      const read = model.read(frame.id);
      const value =
        model.hooks.frameContexts?.(frame, read, model) ??
        model.axeChildren(frame.id).map((child) => ({ frameSelector: selectorOf(child.id), frameContext: { initiator: false } }));
      return { result: { type: 'object', value } };
    }
    if (declaration.includes('runPartial')) {
      this.axeCall(frame, 'runPartial');
      // The frame may have navigated in the hook.
      this.frameOfContext(params.executionContextId);
      const partial =
        frame.partial !== undefined
          ? frame.partial()
          : {
              results: [],
              frames: model.axeChildren(frame.id).map((child) => ({ selector: [selectorOf(child.id)], ancestry: [selectorOf(child.id)] })),
              environmentData: frame.parent === undefined ? {} : undefined,
            };
      // The frame elements, taken as the run ends: each ancestry resolved to a child of this frame.
      const listed = (partial as { frames?: unknown } | null)?.frames;
      const elements = (Array.isArray(listed) ? listed : []).map((spec: { ancestry?: unknown[] }) => {
        const id = String(spec.ancestry?.[0] ?? '').replace(/^#/, '');
        return model.frames.get(id)?.parent === frame.id ? `frame-element:${id}` : null;
      });
      const ranId = `ran:${frame.id}:${model.runs.size}`;
      model.runs.set(ranId, { partial, elements });
      return { result: { type: 'object', objectId: ranId } };
    }
    if (declaration.includes('finishRun')) {
      this.axeCall(frame, 'finishRun');
      const value = model.hooks.finish?.() ?? { violations: [], incomplete: [], passes: [], inapplicable: [] };
      return { result: { type: 'object', value } };
    }
    throw new Error('the fake does not answer this call');
  }

  async detach(): Promise<void> {
    await Promise.resolve();
    this.model.detached.push(this.rootId);
  }
}

/** A page over the model, and the CDP session of its top frame. */
export function fakePage(model: FakeModel): { pw: PwPage; cdp: CDPSession } {
  const top = model.top();
  const handles = new Map<string, { id: string }>();
  const handle = (id: string): { id: string } => {
    const known = handles.get(id);
    if (known !== undefined) return known;
    const made = { id, url: () => model.frames.get(id)?.url ?? '' };
    handles.set(id, made);
    return made;
  };
  const context = {
    newCDPSession: async (target: { id: string }): Promise<CDPSession> => {
      await Promise.resolve();
      const frame = model.frames.get(target.id);
      if (frame === undefined || frame === top || model.localRoot(frame) !== frame || frame.noSession === true) {
        throw new Error('This frame does not have a separate CDP session, it is a part of the parent frame session');
      }
      if (frame.hangs === true && model.opened.includes(frame.id)) {
        return new Promise(() => undefined);
      }
      model.opened.push(frame.id);
      return new FakeSession(model, frame.id) as unknown as CDPSession;
    },
  };
  const pw = {
    frames: () => [...model.frames.keys()].map(handle),
    mainFrame: () => handle(top.id),
    context: () => context,
  };
  return { pw: pw as unknown as PwPage, cdp: new FakeSession(model, top.id) as unknown as CDPSession };
}
