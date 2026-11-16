/**
 * The read checkPage uses to tell a blank page from a page with nothing to Tab to that shows
 * content. The function runs in the browser; here it runs over a small fake DOM, so each rule of
 * the read is checked without one. The real-browser cases are in real.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { PAGE_SHOWS_CONTENT_FUNCTION } from '../../src/deps/real.js';

interface Box {
  width: number;
  height: number;
}

interface FakeNode {
  nodeType: number;
  parentNode: FakeNode | null;
  lastChild: FakeNode | null;
  previousSibling: FakeNode | null;
  [key: string]: unknown;
}

const BOX: Box = { width: 40, height: 16 };
const NO_BOX: Box = { width: 0, height: 0 };

function link(parent: FakeNode, children: FakeNode[]): void {
  let previous: FakeNode | null = null;
  for (const child of children) {
    child.parentNode = parent;
    child.previousSibling = previous;
    previous = child;
  }
  parent.lastChild = previous;
}

function text(data: string, boxes: Box[] = [BOX]): FakeNode {
  const node: FakeNode = { nodeType: 3, data, parentNode: null, lastChild: null, previousSibling: null };
  node['ownerDocument'] = {
    createRange: () => {
      let target: FakeNode | null = null;
      return {
        selectNodeContents: (selected: FakeNode) => {
          target = selected;
        },
        getClientRects: () => (target === node ? boxes : []),
      };
    },
  };
  return node;
}

interface ElementSpec {
  visible?: boolean;
  box?: Box;
  role?: string;
  shadowRoot?: FakeNode;
  contentDocument?: { body: FakeNode } | null;
  // Reading the frame's document throws, as some browsers do for a frame from another origin.
  contentDocumentThrows?: boolean;
  noCheckVisibility?: boolean;
}

function el(localName: string, children: FakeNode[] = [], spec: ElementSpec = {}): FakeNode {
  const node: FakeNode = { nodeType: 1, localName, parentNode: null, lastChild: null, previousSibling: null };
  if (spec.noCheckVisibility !== true) {
    node['checkVisibility'] = () => spec.visible !== false;
  }
  node['getBoundingClientRect'] = () => spec.box ?? BOX;
  node['getAttribute'] = (name: string) => (name === 'role' ? (spec.role ?? null) : null);
  node['shadowRoot'] = spec.shadowRoot ?? null;
  if (spec.contentDocument !== undefined) {
    node['contentDocument'] = spec.contentDocument;
  }
  if (spec.contentDocumentThrows === true) {
    Object.defineProperty(node, 'contentDocument', {
      get: () => {
        throw new Error('Blocked a frame from accessing a cross-origin frame.');
      },
    });
  }
  if (spec.shadowRoot !== undefined) {
    spec.shadowRoot['host'] = node;
  }
  link(node, children);
  return node;
}

function shadowRoot(children: FakeNode[]): FakeNode {
  const root: FakeNode = { nodeType: 11, parentNode: null, lastChild: null, previousSibling: null };
  link(root, children);
  return root;
}

function showsContent(body: FakeNode): boolean {
  const read = new Function('document', `return (${PAGE_SHOWS_CONTENT_FUNCTION})();`) as (document: unknown) => unknown;
  return read({ body }) === true;
}

describe('the read of whether a page shows content', () => {
  it('finds nothing on a blank body', () => {
    expect(showsContent(el('body'))).toBe(false);
  });

  it('counts rendered text, and not text that is only white space', () => {
    expect(showsContent(el('body', [el('p', [text('Terms of use')])]))).toBe(true);
    expect(showsContent(el('body', [el('p', [text('  \n  ')])]))).toBe(false);
  });

  it('does not count text whose element is hidden, or that has no box', () => {
    expect(showsContent(el('body', [el('p', [text('Hidden')], { visible: false })]))).toBe(false);
    expect(showsContent(el('body', [el('p', [text('No box', [NO_BOX])])]))).toBe(false);
  });

  it('does not count script or style text', () => {
    expect(showsContent(el('body', [el('script', [text('window.boot()')]), el('style', [text('p { color: red }')])]))).toBe(false);
  });

  for (const tag of ['img', 'svg', 'canvas', 'video', 'picture', 'object', 'embed']) {
    it(`counts a rendered ${tag} element with a box, and not one with no box or one that is hidden`, () => {
      expect(showsContent(el('body', [el(tag)]))).toBe(true);
      expect(showsContent(el('body', [el(tag, [], { box: NO_BOX })]))).toBe(false);
      expect(showsContent(el('body', [el(tag, [], { visible: false })]))).toBe(false);
    });
  }

  it('counts an element with role img', () => {
    expect(showsContent(el('body', [el('div', [], { role: 'img' })]))).toBe(true);
    expect(showsContent(el('body', [el('div', [], { role: 'img presentation' })]))).toBe(true);
    expect(showsContent(el('body', [el('div', [], { role: 'presentation' })]))).toBe(false);
  });

  it('does not count an empty element that has a box, as a CSS background image has', () => {
    expect(showsContent(el('body', [el('div', [], { box: { width: 300, height: 200 } })]))).toBe(false);
  });

  it('counts an element as hidden when the browser cannot say whether it is visible', () => {
    expect(showsContent(el('body', [el('p', [text('Terms of use')], { noCheckVisibility: true })]))).toBe(false);
    expect(showsContent(el('body', [el('img', [], { noCheckVisibility: true })]))).toBe(false);
  });

  it('reads an open shadow root', () => {
    expect(showsContent(el('body', [el('x-card', [], { shadowRoot: shadowRoot([text('Inside the card')]) })]))).toBe(true);
    expect(showsContent(el('body', [el('x-card', [], { shadowRoot: shadowRoot([el('img')]) })]))).toBe(true);
  });

  it('reads a frame whose document it can reach, and not one it cannot', () => {
    expect(showsContent(el('body', [el('iframe', [], { contentDocument: null })]))).toBe(false);
    expect(showsContent(el('body', [el('iframe', [], { contentDocument: { body: el('body', [el('p', [text('Framed')])]) } })]))).toBe(true);
  });

  // The read cannot see into a frame from another origin. A frame it cannot see into is no evidence
  // that the page rendered, since the frame may hold a blank app, an error page, or a third-party
  // widget. So it is not counted, and a page whose only content is such a frame reads as blank.
  for (const tag of ['iframe', 'frame']) {
    it(`does not count a visible ${tag} with a box whose document it cannot reach`, () => {
      expect(showsContent(el('body', [el(tag, [], { contentDocument: null })]))).toBe(false);
    });

    it(`does not count a visible ${tag} with a box whose document throws when read`, () => {
      expect(showsContent(el('body', [el(tag, [], { contentDocumentThrows: true })]))).toBe(false);
    });

    it(`does not count what a hidden ${tag} shows`, () => {
      const framed = (): { body: FakeNode } => ({ body: el('body', [el('p', [text('Framed')])]) });
      expect(showsContent(el('body', [el(tag, [], { contentDocument: framed() })]))).toBe(true);
      expect(showsContent(el('body', [el(tag, [], { contentDocument: framed(), visible: false })]))).toBe(false);
      expect(showsContent(el('body', [el(tag, [], { contentDocument: framed(), noCheckVisibility: true })]))).toBe(false);
    });

    // A frame whose document the read can reach counts only through what that document shows. An
    // empty frame, such as about:blank or a widget that has not loaded yet, is not content.
    it(`does not count a visible ${tag} with a box whose document it can read and finds empty`, () => {
      expect(showsContent(el('body', [el(tag, [], { contentDocument: { body: el('body') } })]))).toBe(false);
      expect(showsContent(el('body', [el(tag, [], { contentDocument: { body: el('body', [el('div', [], { box: { width: 300, height: 150 } })]) } })]))).toBe(false);
    });

    it(`does not count a ${tag} with no box`, () => {
      expect(showsContent(el('body', [el(tag, [], { contentDocument: null, box: NO_BOX })]))).toBe(false);
      expect(showsContent(el('body', [el(tag, [], { contentDocument: null, box: { width: 300, height: 0 } })]))).toBe(false);
      expect(showsContent(el('body', [el(tag, [], { contentDocument: { body: el('body') }, box: NO_BOX })]))).toBe(false);
    });
  }

  // Frames nested inside readable frames. The read follows eight levels of frames. A frame past that
  // is not counted, so a page it cannot finish reading is reported blank rather than passed. A frame
  // the read cannot see into is not counted at any depth.
  function nestedFrames(levels: number, innermost: FakeNode): FakeNode {
    let body = el('body', [innermost]);
    for (let level = 0; level < levels; level += 1) {
      body = el('body', [el('iframe', [], { contentDocument: { body } })]);
    }
    return body;
  }

  it('counts what nested frames show up to the depth limit, and not past it or through a frame it cannot read', () => {
    expect(showsContent(nestedFrames(1, el('iframe', [], { contentDocument: null })))).toBe(false);
    expect(showsContent(nestedFrames(7, el('iframe', [], { contentDocument: null })))).toBe(false);
    expect(showsContent(nestedFrames(8, el('p', [text('Deep text')])))).toBe(true);
    expect(showsContent(nestedFrames(9, el('p', [text('Deep text')])))).toBe(false);
  });
});
