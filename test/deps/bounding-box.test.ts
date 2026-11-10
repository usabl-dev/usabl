/**
 * The box read for the target size check, run on a small fake page. A real browser runs the same
 * function in roles.real.integration.test.ts. Here each case sets exactly what the scroll into
 * view changes, so a rule about the scroll can be shown to fail and then to hold.
 */
import { describe, expect, it } from 'vitest';
import { BOUNDING_BOX_FUNCTION } from '../../src/deps/real.js';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

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

class FakeElement {
  parentElement: FakeElement | null = null;
  readonly assignedSlot = null;
  readonly style: Record<string, string>;
  clientLeft = 0;
  clientTop = 0;
  clientWidth: number;
  clientHeight: number;
  scrollLeft = 0;
  scrollTop = 0;
  onScrollIntoView: () => void = () => undefined;

  constructor(
    public box: Box,
    style: Record<string, string> = {},
  ) {
    this.style = { ...PLAIN_STYLE, ...style };
    this.clientWidth = box.width;
    this.clientHeight = box.height;
  }

  getBoundingClientRect() {
    const { left, top, width, height } = this.box;
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

  scrollIntoView(): void {
    this.onScrollIntoView();
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
  container: FakeElement;
  control: FakeElement;
  window: FakeWindow;
}

// html > body > container > control. The control is 44 by 44 inside a large container, so no
// named limit holds, and every point of the hit test lands on it unless a case says otherwise.
function fakePage(styles: { root?: Record<string, string>; body?: Record<string, string>; container?: Record<string, string> } = {}): FakePage {
  const root = new FakeElement({ left: 0, top: 0, width: 1280, height: 720 }, styles.root);
  const body = new FakeElement({ left: 0, top: 0, width: 1280, height: 720 }, styles.body);
  const container = new FakeElement({ left: 0, top: 0, width: 400, height: 400 }, styles.container);
  const control = new FakeElement({ left: 100, top: 100, width: 44, height: 44 });
  body.parentElement = root;
  container.parentElement = body;
  control.parentElement = container;
  return { root, body, container, control, window: new FakeWindow() };
}

function readBox(page: FakePage): { width: number; height: number; fragments: number; unmeasurable: string[] } {
  const box = page.control;
  const document = {
    documentElement: page.root,
    body: page.body,
    querySelector: () => page.control,
    elementFromPoint: (x: number, y: number) => {
      const { left, top, width, height } = box.box;
      return x >= left && x <= left + width && y >= top && y <= top + height ? page.control : page.body;
    },
  };
  const build = new Function('document', 'window', 'getComputedStyle', 'Element', 'ShadowRoot', `return (${BOUNDING_BOX_FUNCTION});`);
  const read = build(document, page.window, (node: FakeElement) => node.style, FakeElement, FakeShadowRoot) as (query: string) => never;
  return read('#control');
}

describe('the box read for target size', () => {
  it('finds nothing to limit on a plain control the scroll does not move', () => {
    expect(readBox(fakePage())).toEqual({ width: 44, height: 44, fragments: 1, unmeasurable: [] });
  });

  describe('a control whose size changes when it is scrolled into view', () => {
    it('is limited, and reports the size of the first read', () => {
      // Such as a scroll-driven animation that shrinks the control as it nears the center.
      const page = fakePage();
      page.control.onScrollIntoView = () => {
        page.control.box = { left: 114, top: 114, width: 16, height: 16 };
      };
      expect(readBox(page)).toEqual({ width: 44, height: 44, fragments: 1, unmeasurable: ['size-changed-on-scroll'] });
    });

    it('is limited when only one side changes', () => {
      const page = fakePage();
      page.control.onScrollIntoView = () => {
        page.control.box = { left: 100, top: 100, width: 44, height: 50 };
      };
      expect(readBox(page).unmeasurable).toEqual(['size-changed-on-scroll']);
    });

    it('is not limited by a change smaller than a hundredth of a pixel', () => {
      const page = fakePage();
      page.control.onScrollIntoView = () => {
        page.control.box = { left: 100, top: 300, width: 44.005, height: 43.995 };
      };
      expect(readBox(page).unmeasurable).toEqual([]);
    });
  });

  describe('a scroll a person cannot make', () => {
    it('reads a scroll of a container that hides its overflow as clipped', () => {
      const page = fakePage({ container: { overflowX: 'hidden', overflowY: 'hidden' } });
      page.control.onScrollIntoView = () => {
        page.container.scrollTop = 80;
      };
      expect(readBox(page).unmeasurable).toEqual(['overflow-clipped']);
      // The scroll is still put back.
      expect(page.container.scrollTop).toBe(0);
    });

    it('reads a sideways scroll of a container whose overflow is clip as clipped', () => {
      const page = fakePage({ container: { overflowX: 'clip', overflowY: 'visible' } });
      page.control.onScrollIntoView = () => {
        page.container.scrollLeft = 30;
      };
      expect(readBox(page).unmeasurable).toEqual(['overflow-clipped']);
    });

    it('reads only the axis that moved', () => {
      // Hidden across, scrollable down, and the scroll went down: a person can make that scroll.
      const page = fakePage({ container: { overflowX: 'hidden', overflowY: 'auto' } });
      page.control.onScrollIntoView = () => {
        page.container.scrollTop = 80;
      };
      expect(readBox(page).unmeasurable).toEqual([]);
    });

    it('counts an overflow value it cannot read as hidden', () => {
      const page = fakePage({ container: { overflowX: '', overflowY: '' } });
      page.control.onScrollIntoView = () => {
        page.container.scrollTop = 10;
      };
      expect(readBox(page).unmeasurable).toEqual(['overflow-clipped']);
    });

    it('reads a window scroll as clipped when the root or the body hides overflow on that axis', () => {
      for (const styles of [{ root: { overflowX: 'hidden', overflowY: 'hidden' } }, { body: { overflowX: 'clip', overflowY: 'clip' } }]) {
        const page = fakePage(styles);
        page.control.onScrollIntoView = () => {
          page.window.scrollY = 500;
        };
        expect({ styles, limits: readBox(page).unmeasurable }).toEqual({ styles, limits: ['overflow-clipped'] });
        expect(page.window.scrollY).toBe(0);
      }
    });

    it('passes a scroll a person can make, in a container that scrolls and in the window', () => {
      const page = fakePage({ container: { overflowX: 'auto', overflowY: 'auto' } });
      page.control.onScrollIntoView = () => {
        page.container.scrollTop = 80;
        page.window.scrollY = 500;
      };
      expect(readBox(page).unmeasurable).toEqual([]);
      expect(page.container.scrollTop).toBe(0);
      expect(page.window.scrollY).toBe(0);
    });
  });
});
