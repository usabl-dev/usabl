import { describe, expect, it } from 'vitest';
import type { Draft, Page } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { attachDomSourceToDrafts } from '../../src/providers/dom-source.js';

function makeDraft(elementPath: string): Draft {
  return {
    rule: 'button-name',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'screen',
    elementPath,
    elementName: 'Save',
    role: 'button',
    whatUserExperiences: 'A button has no accessible name',
    why: 'AT users hear an unlabeled control',
    fix: 'Add an accessible name to the button',
    evidence: {},
    confidence: 'fail',
  };
}

describe('attachDomSourceToDrafts', () => {
  it('attaches source file and line from DOM attributes when present', async () => {
    const page = makeFakePage({
      getAttribute: async (_selector: string, name: string) =>
        name === 'data-source-file' ? 'src/pages/Deployments.tsx' : '142',
    });

    const [draft] = await attachDomSourceToDrafts(page, [makeDraft('#save')]);

    expect(draft?.evidence.extra?.['sourceFile']).toBe('src/pages/Deployments.tsx');
    expect(draft?.evidence.extra?.['sourceLine']).toBe(142);
  });

  it('keeps the finding and does not throw when the selector makes the driver throw', async () => {
    // A malformed or non-unique elementPath makes the real driver's getAttribute throw. The hint is
    // presentation only, so a throw must drop the hint and keep the finding, never fail the scan.
    const page: Page = makeFakePage({
      getAttribute: async () => {
        throw new Error('strict mode violation: resolved to 2 elements');
      },
    });
    const original = makeDraft('div');

    const result = await attachDomSourceToDrafts(page, [original]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(original);
    expect(result[0]?.evidence.extra?.['sourceFile']).toBeUndefined();
  });
});
