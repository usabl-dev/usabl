import { describe, expect, it } from 'vitest';
import { HIDDEN_FACTS_IMPL } from '../../src/deps/real.js';
import { createLiveResolver, type HiddenAttributes } from '../../src/providers/rulepack/live-value.js';

const HTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';

// A fake element: the few DOM reads the capture makes on each element of a chain, and nothing else.
interface FakeElement {
  namespaceURI: string;
  localName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

function element(localName: string, attributes: Record<string, string> = {}, namespaceURI: string = HTML): FakeElement {
  return {
    namespaceURI,
    localName,
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => name in attributes,
  };
}

// The capture's own helper, built from its source the way the browser builds it.
const hiddenFacts = new Function(`${HIDDEN_FACTS_IMPL}; return hiddenFacts;`)() as (element: FakeElement) => HiddenAttributes;

// Whether the capture reads a change in the first element of a chain, nearest first, as hidden.
function hidden(chain: FakeElement[]): boolean {
  return createLiveResolver().hiddenInChain(chain.map(hiddenFacts));
}

// A Save button in a modal dialog writes "Saved" into a polite region inside the dialog and closes
// it in the same task. The observer runs after the task, so it climbs a chain whose dialog is
// already closed. The capture recorded the text, and no screen reader speaks it.
describe('the hidden-ancestor rule of the announcement capture', () => {
  const region = element('div', { 'aria-live': 'polite', id: 'message' });
  const main = element('main');
  const body = element('body');

  it('reads a region inside a closed dialog as hidden', () => {
    expect(hidden([region, element('dialog', { id: 'edit' }), main, body])).toBe(true);
  });

  it('reads a region inside an open dialog as shown', () => {
    expect(hidden([region, element('dialog', { id: 'edit', open: '' }), main, body])).toBe(false);
  });

  it('reads a closed dialog as hidden at any depth above the change', () => {
    const wrapper = element('section');
    expect(hidden([element('span'), region, wrapper, element('dialog'), main, body])).toBe(true);
    expect(hidden([element('dialog'), body])).toBe(true);
  });

  it('reads a dialog element outside the HTML namespace as no dialog', () => {
    expect(hidden([region, element('dialog', {}, SVG), main, body])).toBe(false);
  });

  it('keeps reading hidden, inert, and aria-hidden as before', () => {
    expect(hiddenFacts(element('div', { hidden: '', inert: '', 'aria-hidden': 'true' }))).toEqual({
      ariaHidden: 'true',
      inert: true,
      hidden: true,
      closedDialog: false,
    });
    expect(hidden([region, main, body])).toBe(false);
  });
});
