/**
 * The one white space rule for accessible names, used on both sides of every name comparison and
 * on each name a requirement states.
 */
import { describe, expect, it } from 'vitest';
import { collapseWhiteSpace } from '../../src/primitives/accessible-name.js';

describe('collapseWhiteSpace', () => {
  it('reads each run of ASCII white space as one space, with none at either end', () => {
    expect(collapseWhiteSpace(' \t Refresh \n\r\f now  ')).toBe('Refresh now');
    expect(collapseWhiteSpace(' \t\n ')).toBe('');
  });

  it('keeps a no-break space wherever it is, at either end too, because it is not ASCII white space', () => {
    expect(collapseWhiteSpace('Refresh ')).toBe('Refresh ');
    expect(collapseWhiteSpace(' Refresh')).toBe(' Refresh');
    expect(collapseWhiteSpace(' Refresh  ')).toBe('Refresh ');
    expect(collapseWhiteSpace('Re  fresh')).toBe('Re  fresh');
  });

  it('keeps other white space that is not ASCII, such as an ideographic space', () => {
    expect(collapseWhiteSpace('　Refresh　')).toBe('　Refresh　');
  });
});
