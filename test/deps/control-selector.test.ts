/**
 * Whether a click step's selector holds a combinator. The click engine matches a combinator across
 * an open shadow boundary, and the browser's own query cannot, so on a page with an open shadow
 * root such a selector cannot be resolved to the element the click takes. Text inside quotes,
 * attribute brackets, and an nth formula is not a combinator.
 */
import { describe, expect, it } from 'vitest';
import { selectorHasCombinator } from '../../src/deps/real.js';

describe('selectorHasCombinator', () => {
  it('finds a descendant, child, next-sibling, and later-sibling combinator', () => {
    expect(selectorHasCombinator('.row button')).toBe(true);
    expect(selectorHasCombinator('main > button.row-action')).toBe(true);
    expect(selectorHasCombinator('main>button')).toBe(true);
    expect(selectorHasCombinator('h2 + p')).toBe(true);
    expect(selectorHasCombinator('h2~p')).toBe(true);
    expect(selectorHasCombinator(':is(.row button)')).toBe(true);
  });

  it('finds none in a compound selector, or in a list of them', () => {
    expect(selectorHasCombinator('#save')).toBe(false);
    expect(selectorHasCombinator('  button.primary[type="button"]  ')).toBe(false);
    expect(selectorHasCombinator('#save, #cancel')).toBe(false);
    expect(selectorHasCombinator(':not( .hidden )')).toBe(false);
  });

  it('reads no combinator inside quotes, attribute brackets, or an nth formula', () => {
    expect(selectorHasCombinator('[aria-label="Delete row 2"]')).toBe(false);
    expect(selectorHasCombinator("[data-path='a > b']")).toBe(false);
    expect(selectorHasCombinator('[class~=primary]')).toBe(false);
    expect(selectorHasCombinator('li:nth-child(2n + 1)')).toBe(false);
    expect(selectorHasCombinator('[aria-label="a \\" b"] c')).toBe(true);
  });
});
