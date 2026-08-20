import { describe, it, expect } from 'vitest';
import { computeGuardDivergence } from '../../src/guard/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

describe('computeGuardDivergence', () => {
  it('reports no divergence when guarded files match HEAD', async () => {
    const deps = makeFakeDeps({
      files: { 'usabl.config.json': '{"a":1}', 'src/gate/index.ts': 'X' },
      headContents: { 'usabl.config.json': '{"a":1}', 'src/gate/index.ts': 'X' },
    });
    expect(await computeGuardDivergence(deps, ['usabl.config.json', 'src/gate/index.ts'])).toEqual([]);
  });

  it('reports a guarded path whose working tree differs from HEAD', async () => {
    const deps = makeFakeDeps({
      files: { 'usabl.config.json': '{"a":2}' },
      headContents: { 'usabl.config.json': '{"a":1}' },
    });
    expect(await computeGuardDivergence(deps, ['usabl.config.json'])).toEqual(['usabl.config.json']);
  });

  it('treats a guarded path missing from HEAD as diverged', async () => {
    const deps = makeFakeDeps({ files: { 'new.json': '{}' }, headContents: {} });
    expect(await computeGuardDivergence(deps, ['new.json'])).toEqual(['new.json']);
  });

  it('does not diverge when an optional guarded ledger is absent in both places', async () => {
    const deps = makeFakeDeps({ files: {}, headContents: {} });
    expect(await computeGuardDivergence(deps, ['.usabl-evidence.json'])).toEqual([]);
  });
});
