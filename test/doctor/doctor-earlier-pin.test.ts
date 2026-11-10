/**
 * Doctor's step for an earlier 0.3.0 draft says install keeps the engine pin only when the file has
 * one. An earlier draft that still holds the placeholder has no pin to keep.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pinEngineRef, USABL_DOCS_GATE_WORKFLOW_PATH, USABL_GATE_WORKFLOW_PATH } from '../../src/install/ci.js';
import { collectDoctorReport, type SurfaceReport } from '../../src/doctor/index.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const fixture = (name: string): string => readFileSync(new URL(`../../fixtures/install/earlier-0.3.0/${name}`, import.meta.url), 'utf8');

async function report(files: Record<string, string>, id: string): Promise<SurfaceReport> {
  const all = await collectDoctorReport({
    fs: {
      readFile: async (path) => files[path] ?? null,
      glob: async () => [],
      writeFile: async () => {
        throw new Error('doctor must never write');
      },
    },
    gh: { getJson: async () => null },
    configPath: 'usabl.config.json',
    env: {},
    probePlaywrightChromium: async () => 'wired',
    probeChromiumSandbox: async () => 'available',
  });
  const found = all.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no ${id} report`);
  return found;
}

describe('doctor and the engine pin of an earlier draft', () => {
  it('does not promise to keep a pin the earlier gate does not have', async () => {
    const ci = await report({ [USABL_GATE_WORKFLOW_PATH]: fixture('usabl-gate.yml') }, 'ci');
    expect(ci.state).toBe('drifted');
    expect(ci.nextStep).toBe(
      'The gate workflow is the unedited draft an earlier 0.3.0 build wrote, which this version does not recognise. Run "usabl install --ci": it rewrites the file. The file has no engine pin yet, so install pins the engine to the commit this usabl was built from, or prints the line to edit.',
    );
  });

  it('says the pin is kept when the earlier docs gate has one', async () => {
    const docs = await report({ [USABL_DOCS_GATE_WORKFLOW_PATH]: pinEngineRef(fixture('usabl-docs-gate.yml'), SHA) }, 'docs-ci');
    expect(docs.nextStep).toContain('Run "usabl install --docs-ci": it rewrites the file and keeps its engine pin.');
  });
});
