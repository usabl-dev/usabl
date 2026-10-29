import { describe, expect, it } from 'vitest';
import type { Draft } from '../../src/contracts/index.js';
import { AXE_GRADIENT_REASON, isGradientContrastReview } from '../../src/primitives/gradient-contrast.js';

function draft(over: Partial<Draft> = {}, axeData: unknown = { messageKey: 'bgGradient' }): Draft {
  return {
    rule: 'color-contrast',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'clusters',
    elementPath: '.pf-v6-c-button',
    elementName: null,
    role: null,
    whatUserExperiences: 'Needs review',
    why: '',
    fix: '',
    evidence: { extra: { axeData } },
    confidence: 'unverified',
    ...over,
  };
}

describe('isGradientContrastReview', () => {
  it('names the axe-core 4.13.0 reason for a background gradient', () => {
    expect(AXE_GRADIENT_REASON).toBe('bgGradient');
  });

  it('matches an axe color-contrast needs-review result whose reason is a background gradient', () => {
    expect(isGradientContrastReview(draft())).toBe(true);
  });

  it.each([
    ['a background image', { messageKey: 'bgImage' }],
    ['an overlapping element', { messageKey: 'bgOverlap' }],
    ['an image node', { messageKey: 'imgNode' }],
    ['equal colors', { messageKey: 'equalRatio' }],
    ['a reason with different case', { messageKey: 'BgGradient' }],
    ['a reason with a suffix', { messageKey: 'bgGradient2' }],
    ['a reason with spaces', { messageKey: ' bgGradient' }],
    ['no reason', {}],
    ['a reason that is not a string', { messageKey: ['bgGradient'] }],
    ['data that is a string', 'bgGradient'],
    ['data that is an array', ['bgGradient']],
    ['data that is null', null],
  ])('does not match %s', (_name, axeData) => {
    expect(isGradientContrastReview(draft({}, axeData))).toBe(false);
  });

  it('does not match a measured contrast failure, even with the gradient reason', () => {
    expect(isGradientContrastReview(draft({ confidence: 'fail' }))).toBe(false);
  });

  it('does not match another rule or another layer', () => {
    expect(isGradientContrastReview(draft({ rule: 'color-contrast-enhanced' }))).toBe(false);
    expect(isGradientContrastReview(draft({ rule: 'link-in-text-block' }))).toBe(false);
    expect(isGradientContrastReview(draft({ layer: 'pf' }))).toBe(false);
  });

  it('does not match a draft with no axe data', () => {
    expect(isGradientContrastReview({ ...draft(), evidence: {} })).toBe(false);
  });
});
