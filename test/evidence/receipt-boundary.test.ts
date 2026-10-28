/**
 * The exported mintReceipt() checks the ids it is handed. On the command path the config is
 * parsed and the ids come from the gate, so they already passed the id grammar. A library caller
 * that builds the config or the receipt arguments by hand skips both, so the function checks them
 * itself and refuses with a typed error that names the field and never repeats the id.
 */
import { describe, expect, it } from 'vitest';
import { mintReceipt, type ReceiptArgs } from '../../src/evidence/receipt.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { InputRefusedError } from '../../src/intake/input-refusal.js';
import type { UsablConfig } from '../../src/contracts/index.js';

const BAD_ID = 'leak-me​now';
const LEAK = 'leak-me';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'x', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: [] }],
  guardedPaths: ['usabl.config.json'],
};

const args: ReceiptArgs = {
  surfaces: ['cli'],
  checked: ['clusters'],
  notCovered: [],
  applicability: [{ screenId: 'clusters', applied: 1, abstained: 0 }],
  findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
  activeWaivers: 0,
};

async function refusal(call: () => Promise<unknown>): Promise<InputRefusedError> {
  try {
    await call();
  } catch (err) {
    expect(err).toBeInstanceOf(InputRefusedError);
    return err as InputRefusedError;
  }
  throw new Error('expected mintReceipt to refuse its input');
}

describe('mintReceipt() checks every screen and surface id against the id grammar', () => {
  const cases: { field: string; config: UsablConfig; args: ReceiptArgs }[] = [
    { field: 'args.checked[1]', config, args: { ...args, checked: ['clusters', BAD_ID] } },
    {
      field: 'args.applicability[0].screenId',
      config,
      args: { ...args, applicability: [{ screenId: BAD_ID, applied: 1, abstained: 0 }] },
    },
    {
      field: 'config.surfaces[1].id',
      config: { ...config, surfaces: [...config.surfaces, { id: BAD_ID, url: 'http://127.0.0.1:5173/a', files: [] }] },
      args,
    },
    {
      field: 'config.noiseBudget.perSurface key 2',
      config: { ...config, noiseBudget: { perSurface: { clusters: 3, [BAD_ID]: 4 } } },
      args,
    },
  ];

  for (const { field, config: badConfig, args: badArgs } of cases) {
    it(`refuses a bad id in ${field}, naming the field and never the id`, async () => {
      const err = await refusal(() => mintReceipt(makeFakeDeps(), badConfig, badArgs));
      expect(err.field).toBe(field);
      expect(err.message).toContain(field);
      expect(err.message).toContain('U+200B');
      expect(err.message).not.toContain(LEAK);
    });
  }

  it('still mints a receipt from well-formed input', async () => {
    const receipt = await mintReceipt(makeFakeDeps(), config, args);
    expect(receipt.coverage.checked).toEqual(['clusters']);
  });
});
