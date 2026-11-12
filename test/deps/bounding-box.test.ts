/**
 * The box read for the target size check, run on a small fake page. A real browser runs the same
 * function in roles.real.integration.test.ts. The fake lays out one scroll box inside a document
 * and models scrollIntoView the way the browser does: a `nearest` scroll moves a box only when
 * the control is not fully inside that box's scrollport and does not cover it, a `center` scroll
 * centers it, and every scroll stays between 0 and the most the content allows. So a rule about
 * the scroll can be shown to fail and then to hold.
 */
import { describe, expect, it } from 'vitest';
import { BOUNDING_BOX_FUNCTION } from '../../src/deps/real.js';

const VIEWPORT = { width: 1280, height: 720 };

const PLAIN_STYLE: Readonly<Record<string, string>> = {
  transform: 'none',
  rotate: 'none',
  clipPath: 'none',
  clip: 'auto',
  maskImage: 'none',
  webkitMaskImage: 'none',
  position: 'static',
  display: 'block',
  contain: 'none',
  overflowX: 'visible',
  overflowY: 'visible',
};

interface Size {
  width: number;
  height: number;
}

interface Rect extends Size {
  left: number;
  top: number;
}

interface Setup {
  // The size of the document the window scrolls. The default is the viewport.
  document?: Size;
  root?: Record<string, string>;
  body?: Record<string, string>;
  // The size the root reports as its client size. The default is the viewport.
  rootClient?: Size;
  // The scroll box, in document coordinates, and the size of its content.
  // `offset` is the box's layout size, which differs from its size on screen under a scale.
  box?: Rect & { content?: Size; style?: Record<string, string>; layoutClient?: Size; offset?: Size };
  // Where the control sits inside the box's content, and its size.
  control?: Rect;
  // What happens after a centered scroll, such as an animation that resizes the control.
  onCenter?: (page: FakePage) => void;
  throwOnCenter?: boolean;
  // Something laid over the page that does not scroll with the control, in viewport coordinates:
  // a sticky footer inside the box, or a fixed panel. The window's scroll is passed in for a cover
  // that moves with the page but not with the box.
  cover?: (window: FakeWindow) => Rect;
}

type Scroll = 'nearest' | 'center';

// Where one axis of a scroll box ends up for a scroll that brings [start, start + size) into a
// scrollport of the given size, as the browser computes it.
function scrolledTo(current: number, start: number, size: number, port: number, max: number, mode: Scroll): number {
  let next: number;
  if (mode === 'center') {
    next = start + size / 2 - port / 2;
  } else {
    // The CSSOM rule for nearest: no scroll when the control is inside the port or covers it;
    // otherwise align the near edge when the control is past the start and fits, or past the end
    // and does not fit, and align the far edge in the other two cases.
    const before = start < current;
    const after = start + size > current + port;
    const fits = size <= port;
    if (before === after) {
      next = current;
    } else if ((before && fits) || (after && !fits)) {
      next = start;
    } else {
      next = start + size - port;
    }
  }
  return Math.min(Math.max(next, 0), Math.max(max, 0));
}

class FakeElement {
  parentElement: FakeElement | null = null;
  readonly assignedSlot = null;
  readonly style: Record<string, string>;
  clientLeft = 0;
  clientTop = 0;
  scrollLeft = 0;
  scrollTop = 0;

  constructor(
    private readonly rect: () => Rect,
    private readonly client: () => Size,
    style: Record<string, string> = {},
    private readonly onScrollIntoView: (options: { block: Scroll; inline: Scroll }) => void = () => undefined,
    // The layout size of the border box, which no transform changes. The default is the size on
    // screen, as with no scale.
    private readonly offset: () => Size = () => rect(),
  ) {
    this.style = { ...PLAIN_STYLE, ...style };
  }

  get offsetWidth(): number {
    return this.offset().width;
  }

  get offsetHeight(): number {
    return this.offset().height;
  }

  get clientWidth(): number {
    return this.client().width;
  }

  get clientHeight(): number {
    return this.client().height;
  }

  getBoundingClientRect() {
    const { left, top, width, height } = this.rect();
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  getClientRects() {
    return { length: 1 };
  }

  getRootNode() {
    return {};
  }

  contains(other: FakeElement | null): boolean {
    for (let node = other; node !== null; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }

  scrollTo(options: { left: number; top: number }): void {
    this.scrollLeft = options.left;
    this.scrollTop = options.top;
  }

  scrollIntoView(options: { block: Scroll; inline: Scroll }): void {
    this.onScrollIntoView(options);
  }
}

class FakeShadowRoot {}

class FakeWindow {
  scrollX = 0;
  scrollY = 0;
  scrollTo(options: { left: number; top: number }): void {
    this.scrollX = options.left;
    this.scrollY = options.top;
  }
}

interface FakePage {
  root: FakeElement;
  body: FakeElement;
  box: FakeElement;
  control: FakeElement;
  window: FakeWindow;
  controlSize: Size;
  cover: FakeElement | null;
}

// html > body > box > control.
function fakePage(setup: Setup = {}): FakePage {
  const doc = setup.document ?? VIEWPORT;
  const boxSpec = setup.box ?? { left: 0, top: 0, width: 400, height: 400 };
  const content = boxSpec.content ?? { width: boxSpec.width, height: boxSpec.height };
  const at = setup.control ?? { left: 100, top: 100, width: 44, height: 44 };
  const win = new FakeWindow();
  const page = { window: win, controlSize: { width: at.width, height: at.height } } as FakePage;
  const docRect = (): Rect => ({ left: -win.scrollX, top: -win.scrollY, ...doc });
  const boxRect = (): Rect => ({ left: boxSpec.left - win.scrollX, top: boxSpec.top - win.scrollY, width: boxSpec.width, height: boxSpec.height });
  const controlRect = (): Rect => {
    const outer = boxRect();
    return { left: outer.left + at.left - page.box.scrollLeft, top: outer.top + at.top - page.box.scrollTop, ...page.controlSize };
  };
  const scroll = (options: { block: Scroll; inline: Scroll }): void => {
    const size = page.controlSize;
    const box = page.box;
    box.scrollLeft = scrolledTo(box.scrollLeft, at.left, size.width, boxSpec.width, content.width - boxSpec.width, options.inline);
    box.scrollTop = scrolledTo(box.scrollTop, at.top, size.height, boxSpec.height, content.height - boxSpec.height, options.block);
    const docLeft = boxSpec.left + at.left - box.scrollLeft;
    const docTop = boxSpec.top + at.top - box.scrollTop;
    win.scrollX = scrolledTo(win.scrollX, docLeft, size.width, VIEWPORT.width, doc.width - VIEWPORT.width, options.inline);
    win.scrollY = scrolledTo(win.scrollY, docTop, size.height, VIEWPORT.height, doc.height - VIEWPORT.height, options.block);
    if (options.block === 'center') {
      setup.onCenter?.(page);
      if (setup.throwOnCenter === true) {
        throw new Error('the centered scroll failed');
      }
    }
  };
  page.root = new FakeElement(docRect, () => setup.rootClient ?? VIEWPORT, setup.root);
  page.body = new FakeElement(docRect, () => doc, setup.body);
  // A box's client size is the size of its scrollport, unless the case gives the overflow limit
  // another one. Its layout size (offset) is its size on screen, unless the case models a scale.
  const boxOffset = boxSpec.offset;
  page.box = new FakeElement(
    boxRect,
    () => boxSpec.layoutClient ?? { width: boxSpec.width, height: boxSpec.height },
    boxSpec.style,
    undefined,
    boxOffset === undefined ? undefined : () => boxOffset,
  );
  page.control = new FakeElement(controlRect, () => page.controlSize, {}, scroll);
  const coverRect = setup.cover;
  page.cover = coverRect === undefined ? null : new FakeElement(() => coverRect(win), () => ({ width: 0, height: 0 }));
  page.body.parentElement = page.root;
  page.box.parentElement = page.body;
  page.control.parentElement = page.box;
  if (page.cover !== null) page.cover.parentElement = page.body;
  return page;
}

function inside(x: number, y: number, rect: Rect): boolean {
  return x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
}

function readBox(page: FakePage): { width: number; height: number; fragments: number; unmeasurable: string[] } {
  const clips = page.box.style.overflowX !== 'visible' || page.box.style.overflowY !== 'visible';
  const document = {
    documentElement: page.root,
    body: page.body,
    querySelector: () => page.control,
    elementFromPoint: (x: number, y: number) => {
      if (!inside(x, y, { left: 0, top: 0, ...VIEWPORT })) return null;
      if (page.cover !== null && inside(x, y, page.cover.getBoundingClientRect())) return page.cover;
      const onControl = inside(x, y, page.control.getBoundingClientRect());
      const shown = !clips || inside(x, y, page.box.getBoundingClientRect());
      return onControl && shown ? page.control : page.body;
    },
  };
  const build = new Function('document', 'window', 'getComputedStyle', 'Element', 'ShadowRoot', `return (${BOUNDING_BOX_FUNCTION});`);
  const read = build(document, page.window, (node: FakeElement) => node.style, FakeElement, FakeShadowRoot) as (query: string) => never;
  return read('#control');
}

const HIDDEN = { overflowX: 'hidden', overflowY: 'hidden' };

// The fake's scroll must follow the CSSOM rule, or a case could pass or fail on a scroll no browser
// makes. For `nearest`, a control larger than the scrollport that covers it leaves the box where it
// is, and one that sits partly before the port is aligned by its far edge.
describe('the fake scroll for a control larger than its scrollport', () => {
  it('follows the browser rule for nearest', () => {
    // The port shows 50 to 150. A 200 pixel control at 20 to 220 covers it: no scroll.
    expect(scrolledTo(50, 20, 200, 100, 500, 'nearest')).toBe(50);
    // A 200 pixel control at 0 to 200, with the port at 150 to 250: its far edge is aligned.
    expect(scrolledTo(150, 0, 200, 100, 500, 'nearest')).toBe(100);
    // A 200 pixel control at 300 to 500, with the port at 150 to 250: its near edge is aligned.
    expect(scrolledTo(150, 300, 200, 100, 500, 'nearest')).toBe(300);
  });
});

describe('the box read for target size', () => {
  it('finds nothing to limit on a plain control the scroll does not move', () => {
    expect(readBox(fakePage())).toEqual({ width: 44, height: 44, fragments: 1, unmeasurable: [] });
  });

  describe('a control whose size changes when it is scrolled into view', () => {
    it('is limited, and reports the size of the first read', () => {
      // Such as a scroll-driven animation that shrinks the control as it nears the center.
      const page = fakePage({ onCenter: (p) => (p.controlSize = { width: 16, height: 16 }) });
      expect(readBox(page)).toEqual({ width: 44, height: 44, fragments: 1, unmeasurable: ['size-changed-on-scroll'] });
    });

    it('is limited when only one side changes', () => {
      const page = fakePage({ onCenter: (p) => (p.controlSize = { width: 44, height: 50 }) });
      expect(readBox(page).unmeasurable).toEqual(['size-changed-on-scroll']);
    });

    it('is not limited by a change smaller than a hundredth of a pixel', () => {
      const page = fakePage({ onCenter: (p) => (p.controlSize = { width: 44.005, height: 43.995 }) });
      expect(readBox(page).unmeasurable).toEqual([]);
    });
  });

  describe('a scroll a person cannot make', () => {
    // A box 100 pixels high whose content is 600 high. The fake gives the overflow limit a client
    // size of 600, so it does not see the clip, and only the scroll rule can. The hit test then runs
    // where a person meets the control, still hidden, so it misses too.
    const BOTH = ['overflow-clipped', 'hit-test-missed'];
    const tall = (style: Record<string, string>) => ({
      left: 0,
      top: 0,
      width: 400,
      height: 100,
      content: { width: 400, height: 600 },
      layoutClient: { width: 400, height: 600 },
      style,
    });

    it('reads a control that only a scroll of a box that hides its overflow can show as clipped', () => {
      const page = fakePage({ box: tall(HIDDEN), control: { left: 100, top: 300, width: 44, height: 44 } });
      expect(readBox(page).unmeasurable).toEqual(BOTH);
      // The scroll is still put back.
      expect(page.box.scrollTop).toBe(0);
    });

    it('reads a sideways scroll of a box whose overflow is clip as clipped', () => {
      const page = fakePage({
        box: { left: 0, top: 0, width: 100, height: 400, content: { width: 600, height: 400 }, layoutClient: { width: 600, height: 400 }, style: { overflowX: 'clip' } },
        control: { left: 300, top: 100, width: 44, height: 44 },
      });
      expect(readBox(page).unmeasurable).toEqual(BOTH);
    });

    it('reads only the axis that moved', () => {
      // Hidden across, scrollable down, and the scroll went down: a person can make that scroll.
      const page = fakePage({ box: tall({ overflowX: 'hidden', overflowY: 'auto' }), control: { left: 100, top: 300, width: 44, height: 44 } });
      expect(readBox(page).unmeasurable).toEqual([]);
    });

    it('counts an overflow value it cannot read as hidden', () => {
      const page = fakePage({ box: tall({ overflowX: '', overflowY: '' }), control: { left: 100, top: 300, width: 44, height: 44 } });
      expect(readBox(page).unmeasurable).toEqual(BOTH);
    });

    it('reads a window scroll as clipped when the root or the body hides overflow on that axis', () => {
      for (const styles of [{ root: HIDDEN }, { body: { overflowX: 'clip', overflowY: 'clip' } }]) {
        const page = fakePage({
          ...styles,
          document: { width: 1280, height: 3000 },
          rootClient: { width: 1280, height: 3000 },
          box: { left: 0, top: 1000, width: 400, height: 400 },
        });
        expect({ styles, limits: readBox(page).unmeasurable }).toEqual({ styles, limits: BOTH });
        expect(page.window.scrollY).toBe(0);
      }
    });

    it('passes a scroll a person can make, in a box that scrolls and in the window', () => {
      const page = fakePage({
        document: { width: 1280, height: 3000 },
        box: { left: 0, top: 1000, width: 400, height: 100, content: { width: 400, height: 600 }, style: { overflowX: 'auto', overflowY: 'auto' } },
        control: { left: 100, top: 50, width: 44, height: 44 },
      });
      expect(readBox(page).unmeasurable).toEqual([]);
      expect(page.box.scrollTop).toBe(0);
      expect(page.window.scrollY).toBe(0);
    });

    it('does not count a centered scroll of a box that hides its overflow when the control is already fully in view', () => {
      // A carousel: the control is wholly inside the visible part, but not at its center.
      const page = fakePage({
        box: { left: 0, top: 0, width: 400, height: 100, content: { width: 400, height: 600 }, style: HIDDEN },
        control: { left: 100, top: 50, width: 44, height: 44 },
      });
      expect(readBox(page).unmeasurable).toEqual([]);
    });

    it('does not count a centered sideways scroll of the window when the body hides overflow and the control is in view', () => {
      const page = fakePage({
        body: { overflowX: 'hidden', overflowY: 'visible' },
        document: { width: 3000, height: 720 },
        box: { left: 0, top: 0, width: 1280, height: 400 },
        control: { left: 900, top: 100, width: 44, height: 44 },
      });
      expect(readBox(page).unmeasurable).toEqual([]);
    });
  });

  describe('the hit test runs only where a person can bring the control', () => {
    it('misses a control under a sticky footer in a box that hides its overflow', () => {
      // At rest the button is at 150 to 194, inside the 200 pixel box and under the footer at 140 to
      // 200. A centered scroll of the box would bring it out, but a person cannot make that scroll.
      const page = fakePage({
        box: { left: 0, top: 0, width: 400, height: 200, content: { width: 400, height: 594 }, style: HIDDEN },
        control: { left: 100, top: 150, width: 44, height: 44 },
        cover: (w) => ({ left: 0 - w.scrollX, top: 140 - w.scrollY, width: 400, height: 60 }),
      });
      expect(readBox(page).unmeasurable).toEqual(['hit-test-missed']);
      expect([page.box.scrollLeft, page.box.scrollTop, page.window.scrollX, page.window.scrollY]).toEqual([0, 0, 0, 0]);
    });

    it('misses a control under a fixed panel on a page whose body hides sideways overflow', () => {
      // The page is 3000 pixels wide. A centered scroll of the window would move the button at 1200
      // out from under the panel over the right 200 pixels, but a person cannot scroll sideways.
      const page = fakePage({
        body: { overflowX: 'hidden', overflowY: 'visible' },
        document: { width: 3000, height: 720 },
        box: { left: 0, top: 0, width: 3000, height: 400 },
        control: { left: 1200, top: 100, width: 44, height: 44 },
        cover: () => ({ left: 1080, top: 0, width: 200, height: 720 }),
      });
      expect(readBox(page).unmeasurable).toEqual(['hit-test-missed']);
      expect([page.window.scrollX, page.window.scrollY]).toEqual([0, 0]);
    });

    it('still centers a box a person can scroll, so a cover only at rest there does not count', () => {
      // The same footer in a box that scrolls: a person can scroll the button out from under it.
      const page = fakePage({
        box: { left: 0, top: 0, width: 400, height: 200, content: { width: 400, height: 594 }, style: { overflowX: 'auto', overflowY: 'auto' } },
        control: { left: 100, top: 150, width: 44, height: 44 },
        cover: (w) => ({ left: 0 - w.scrollX, top: 140 - w.scrollY, width: 400, height: 60 }),
      });
      expect(readBox(page).unmeasurable).toEqual([]);
      expect(page.box.scrollTop).toBe(0);
    });
  });

  // getBoundingClientRect includes every transform, while clientWidth and clientHeight are layout
  // sizes. The clip edges must be in the units of the control's box, so the client sizes are scaled
  // by the ratio of the box on screen to its layout size.
  describe('the overflow limit under a scale', () => {
    it('reads the clip of a box scaled to half as half its layout size', () => {
      // A 40 pixel high box that hides its overflow, at scale(0.5): 20 pixels on screen. The button
      // is 60 by 60 in layout, 30 by 30 on screen, so only 20 of its 30 pixels show.
      const page = fakePage({
        box: { left: 0, top: 0, width: 200, height: 20, offset: { width: 400, height: 40 }, layoutClient: { width: 400, height: 40 }, style: HIDDEN },
        control: { left: 0, top: 0, width: 30, height: 30 },
      });
      expect(readBox(page).unmeasurable).toEqual(['overflow-clipped', 'hit-test-missed']);
    });

    it('does not read a clip past the layout size of a box scaled up', () => {
      // A 400 by 200 box at scale(2) is 800 by 400 on screen. The button inside the visible part,
      // past the layout size, is not clipped.
      const page = fakePage({
        box: { left: 0, top: 0, width: 800, height: 400, offset: { width: 400, height: 200 }, layoutClient: { width: 400, height: 200 }, style: HIDDEN },
        control: { left: 500, top: 300, width: 44, height: 44 },
      });
      expect(readBox(page).unmeasurable).toEqual([]);
    });

    it('reads a box whose layout size it cannot read as clipped', () => {
      for (const offset of [
        { width: 0, height: 0 },
        { width: 400, height: 0 },
        { width: Number.NaN, height: 400 },
      ]) {
        const page = fakePage({ box: { left: 0, top: 0, width: 400, height: 400, offset, style: HIDDEN } });
        expect({ offset, limits: readBox(page).unmeasurable }).toEqual({ offset, limits: ['overflow-clipped'] });
      }
    });

    it('reads the ratio only on an axis the box clips', () => {
      // The box clips across only, so a height it cannot read does not matter.
      const page = fakePage({
        box: { left: 0, top: 0, width: 400, height: 400, offset: { width: 400, height: 0 }, style: { overflowX: 'hidden', overflowY: 'visible' } },
      });
      expect(readBox(page).unmeasurable).toEqual([]);
    });
  });

  // The five points sit 1 pixel inside each edge, so a box under 2 pixels on a side cannot hold
  // them, and a box with no area has no point inside it at all. Such a box must fail on size, as it
  // did before the hit test, so the hit test does not run and adds no limit.
  describe('a box too small to hold the points', () => {
    for (const size of [
      { width: 1, height: 44 },
      { width: 44, height: 1 },
      { width: 1.5, height: 1.5 },
      { width: 0, height: 0 },
    ]) {
      it(`adds no hit test limit for a ${size.width} by ${size.height} box, and does not scroll`, () => {
        const page = fakePage({
          document: { width: 1280, height: 3000 },
          box: { left: 0, top: 1000, width: 400, height: 400 },
          control: { left: 100, top: 100, ...size },
        });
        expect(readBox(page)).toEqual({ ...size, fragments: 1, unmeasurable: [] });
        expect([page.window.scrollX, page.window.scrollY]).toEqual([0, 0]);
      });
    }

    it('still runs the hit test on a box exactly 2 pixels on each side', () => {
      const page = fakePage({
        box: { left: 0, top: 0, width: 400, height: 400 },
        control: { left: 100, top: 100, width: 2, height: 2 },
        cover: () => ({ left: 100, top: 100, width: 2, height: 2 }),
      });
      expect(readBox(page).unmeasurable).toEqual(['hit-test-missed']);
    });

    it('keeps the other limits on a box too small for the points', () => {
      const page = fakePage({
        box: { left: 0, top: 0, width: 400, height: 100, style: HIDDEN },
        control: { left: 100, top: 150, width: 1, height: 44 },
      });
      expect(readBox(page).unmeasurable).toEqual(['overflow-clipped']);
    });
  });

  describe('scroll positions', () => {
    const scrolled = (setup: Setup): FakePage => {
      const page = fakePage({
        document: { width: 1280, height: 3000 },
        box: { left: 0, top: 1000, width: 400, height: 100, content: { width: 400, height: 600 }, style: { overflowX: 'auto', overflowY: 'auto' } },
        control: { left: 100, top: 300, width: 44, height: 44 },
        ...setup,
      });
      page.box.scrollTop = 10;
      page.window.scrollY = 20;
      return page;
    };

    it('puts back every position after both scrolls', () => {
      const page = scrolled({});
      readBox(page);
      expect([page.box.scrollTop, page.window.scrollY]).toEqual([10, 20]);
    });

    it('puts back every position when the second scroll throws, and counts the throw as a miss', () => {
      const page = scrolled({ throwOnCenter: true });
      expect(readBox(page).unmeasurable).toContain('hit-test-missed');
      expect([page.box.scrollTop, page.window.scrollY]).toEqual([10, 20]);
    });
  });
});
