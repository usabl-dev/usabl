/**
 * Doctor is a read-only projection of what is wired, missing, drifted, or unknown. These
 * tests hold the honesty bar at the doctor layer: recognition must never fail toward
 * success. A surface that cannot be positively confirmed reports a lower-confidence state
 * (missing, drifted, or unknown), never "wired". Doctor also mints no verdict, so every
 * run that renders a report exits 0 no matter how many surfaces are unwired. The reuse of
 * the A3 recognition predicates is asserted to be load-bearing: a commented-out overlay,
 * a foreign Stop hook, and an unavailable gh must not read as wired.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import type { GhReader, GhResult } from '../../src/install/branch-rule.js';
import { ENGINE_REF_PLACEHOLDER, USABL_GATE_WORKFLOW } from '../../src/install/ci.js';
import { testConfig } from '../helpers.js';
import {
  collectDoctorReport,
  formatDoctorReport,
  runDoctor,
  type SurfaceReport,
  type SurfaceState,
} from '../../src/doctor/index.js';

// A read-only InstallFs: writeFile throws so a doctor path that ever tried to write fails
// loudly instead of silently mutating the tree.
function readOnlyFs(files: Record<string, string>): InstallFs {
  const store = { ...files };
  return {
    readFile: async (path) => store[path] ?? null,
    glob: async (patterns) => Object.keys(store).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async () => {
      throw new Error('doctor must never write');
    },
  };
}

// An InstallFs whose reads fail like the file system does: an Error carrying a string `code`
// (EACCES, EIO, and the like). Doctor must map this to unknown, never crash or read as wired.
function fsFailingWith(code: string): InstallFs {
  const fail = async (): Promise<never> => {
    throw Object.assign(new Error(`simulated ${code}`), { code });
  };
  return {
    readFile: fail,
    glob: fail,
    writeFile: async () => {
      throw new Error('doctor must never write');
    },
  };
}

// An InstallFs whose read throws a plain programmer error with no fs `code`. Doctor must let
// this propagate (exit 4), never mask a real bug as an unknown surface.
function fsThrowingProgrammerError(): InstallFs {
  return {
    readFile: async () => {
      throw new TypeError('programmer error, not an fs failure');
    },
    glob: async () => [],
    writeFile: async () => {
      throw new Error('doctor must never write');
    },
  };
}

function ghReplying(reply: (endpoint: string) => GhResult | null): GhReader {
  return { getJson: async (endpoint) => reply(endpoint) };
}

const GH_VERIFIED = ghReplying(() => ({
  code: 0,
  stdout: JSON.stringify({
    required_status_checks: { strict: true, checks: [{ context: 'usabl-policy', app_id: -1 }] },
  }),
  stderr: '',
}));

const GH_NOT_PROTECTED = ghReplying(() => ({
  code: 1,
  stdout: '',
  stderr: 'gh: Branch not protected (HTTP 404)',
}));

const GH_UNAVAILABLE = ghReplying(() => null);

const VALID_CONFIG = JSON.stringify(testConfig());
const VALID_ROUTES = JSON.stringify({ routes: [{ screenId: 'home', url: '/home', entryFile: null }] });
const VALID_FLOOR = JSON.stringify({ version: 1, entries: [] });
const VALID_WAIVERS = JSON.stringify({ version: 1, waivers: [] });
const WIRED_OVERLAY = `import { defineConfig } from 'vite'
import { usablVitePluginFromConfig } from 'usabl/vite'
export default defineConfig({ plugins: [usablVitePluginFromConfig({ cwd: import.meta.dirname })] })
`;
const WIRED_CLAUDE = `${JSON.stringify(
  { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'npx usabl stop-hook' }] }] } },
  null,
  2,
)}\n`;
const RETIRED_CLAUDE = `${JSON.stringify(
  { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node ./node_modules/usabl/dist/stop-hook-runner.js' }] }] } },
  null,
  2,
)}\n`;
const FOREIGN_CLAUDE = `${JSON.stringify(
  { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } },
  null,
  2,
)}\n`;
// settings.json that exists and is valid but carries no usabl Stop hook at all. This is a
// missing surface for doctor, not a retired-path drift.
const CLAUDE_WITHOUT_HOOK = `${JSON.stringify({ model: 'opus' }, null, 2)}\n`;
// A bare "usabl stop-hook" command: usabl-owned but not the stable "npx usabl stop-hook".
// This is a normalize case (drifted), and its next step must not claim a retired dist path.
const BARE_CLAUDE = `${JSON.stringify(
  { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'usabl stop-hook' }] }] } },
  null,
  2,
)}\n`;

// A gate workflow correctly pinned to a real 40-character commit SHA at both engine-ref
// lines. This, not the sentinel-carrying draft, is the wired shape for doctor.
const TRUSTED_SHA = '0123456789abcdef0123456789abcdef01234567';
const PINNED_WORKFLOW = USABL_GATE_WORKFLOW.replaceAll(ENGINE_REF_PLACEHOLDER, TRUSTED_SHA);

const FULLY_WIRED_FILES: Record<string, string> = {
  'usabl.config.json': VALID_CONFIG,
  'usabl.routes.json': VALID_ROUTES,
  '.usabl-evidence.json': VALID_FLOOR,
  '.usabl-waivers.json': VALID_WAIVERS,
  'vite.config.ts': WIRED_OVERLAY,
  '.claude/settings.json': WIRED_CLAUDE,
  '.github/workflows/usabl-gate.yml': PINNED_WORKFLOW,
};

function byId(reports: SurfaceReport[], id: string): SurfaceReport {
  const found = reports.find((r) => r.id === id);
  if (found === undefined) {
    throw new Error(`no surface report with id ${id}`);
  }
  return found;
}

function stateOf(reports: SurfaceReport[], id: string): SurfaceState {
  return byId(reports, id).state;
}

describe('collectDoctorReport', () => {
  it('reports every surface wired for a fully wired repo', async () => {
    const reports = await collectDoctorReport({
      fs: readOnlyFs(FULLY_WIRED_FILES),
      gh: GH_VERIFIED,
      configPath: 'usabl.config.json',
    });

    expect(reports.length).toBeGreaterThanOrEqual(8);
    for (const report of reports) {
      expect(report.state).toBe('wired');
    }
  });

  it('reports every surface missing for a bare repo and names a next step', async () => {
    // A bare repo has no usabl files. main exists on GitHub but carries no protection, so
    // gh returns the confident "Branch not protected" signal and branch-rule reads missing.
    const reports = await collectDoctorReport({
      fs: readOnlyFs({}),
      gh: GH_NOT_PROTECTED,
      configPath: 'usabl.config.json',
    });

    for (const report of reports) {
      expect(report.state).toBe('missing');
      expect(report.nextStep.length).toBeGreaterThan(0);
    }
  });

  it('reports a realistic mix for a partially wired repo', async () => {
    const reports = await collectDoctorReport({
      fs: readOnlyFs({
        'usabl.config.json': VALID_CONFIG,
        'vite.config.ts': WIRED_OVERLAY,
      }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });

    expect(stateOf(reports, 'config')).toBe('wired');
    expect(stateOf(reports, 'overlay')).toBe('wired');
    expect(stateOf(reports, 'ci')).toBe('missing');
    expect(stateOf(reports, 'routes')).toBe('missing');
    expect(stateOf(reports, 'branch-rule')).toBe('unknown');
  });
});

describe('doctor honesty locks', () => {
  it('never reads a commented-out or quoted overlay mention as wired', async () => {
    const commented = `import { defineConfig } from 'vite'
import { usablVitePluginFromConfig } from 'usabl/vite'
export default defineConfig({
  plugins: [
    // usablVitePluginFromConfig({ cwd: import.meta.dirname }),
  ],
})
`;
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ 'vite.config.ts': commented }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    const overlay = stateOf(reports, 'overlay');
    expect(overlay).not.toBe('wired');
    // Config present but overlay not wired is a drift, not an absence.
    expect(overlay).toBe('drifted');
  });

  it('reports a foreign Stop hook as unknown, never wired', async () => {
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ '.claude/settings.json': FOREIGN_CLAUDE }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(stateOf(reports, 'stop-hook')).toBe('unknown');
  });

  it('reports a retired-path usabl Stop hook as drifted with a normalize step', async () => {
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ '.claude/settings.json': RETIRED_CLAUDE }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(stateOf(reports, 'stop-hook')).toBe('drifted');
    // The retired path is one normalize case among several. The step must not overclaim it
    // as the specific problem, since a bare command drifts here too.
    expect(byId(reports, 'stop-hook').nextStep.toLowerCase()).toContain('normalize');
  });

  it('reports settings.json that exists without a usabl Stop hook as missing, not a false retired-path drift', async () => {
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ '.claude/settings.json': CLAUDE_WITHOUT_HOOK }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    // Load-bearing: the file exists but has no usabl Stop hook, so the surface is missing, not
    // drifted. The old code collapsed this into a single "retired dist path" drift.
    expect(stateOf(reports, 'stop-hook')).toBe('missing');
    expect(byId(reports, 'stop-hook').nextStep.toLowerCase()).not.toContain('retired');
  });

  it('reports a bare usabl stop-hook command as drifted with a normalize step, never a retired-path claim', async () => {
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ '.claude/settings.json': BARE_CLAUDE }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(stateOf(reports, 'stop-hook')).toBe('drifted');
    const step = byId(reports, 'stop-hook').nextStep.toLowerCase();
    expect(step).toContain('normalize');
    expect(step).not.toContain('retired');
  });

  it('reports branch-rule as unknown when gh is unavailable, never missing or wired', async () => {
    const reports = await collectDoctorReport({
      fs: readOnlyFs(FULLY_WIRED_FILES),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    const branchRule = stateOf(reports, 'branch-rule');
    expect(branchRule).toBe('unknown');
    expect(branchRule).not.toBe('missing');
    expect(branchRule).not.toBe('wired');
  });

  it('reports a malformed config as drifted without crashing', async () => {
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ 'usabl.config.json': '{ this is not valid json' }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(stateOf(reports, 'config')).toBe('drifted');
  });

  it('reports a malformed routes manifest as drifted', async () => {
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ 'usabl.routes.json': '{ broken' }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(stateOf(reports, 'routes')).toBe('drifted');
  });

  it('reports a malformed evidence floor as drifted', async () => {
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ '.usabl-evidence.json': '{ "version": 2 }' }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(stateOf(reports, 'evidence-floor')).toBe('drifted');
  });

  it('reports a malformed waiver ledger as drifted', async () => {
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ '.usabl-waivers.json': '{ "version": 1, "waivers": "nope" }' }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(stateOf(reports, 'waivers')).toBe('drifted');
  });

  it('reports a differing ci workflow as drifted, never wired', async () => {
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ '.github/workflows/usabl-gate.yml': 'name: something-else\n' }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(stateOf(reports, 'ci')).toBe('drifted');
  });

  it('reports a ci workflow pinned to a real commit SHA as wired', async () => {
    // The one wired shape: structurally identical to the draft, with both engine-ref lines
    // carrying the same real 40-character commit SHA. This is the mutation-check anchor for
    // the classifyGateWorkflow SHA guard.
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ '.github/workflows/usabl-gate.yml': PINNED_WORKFLOW }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(stateOf(reports, 'ci')).toBe('wired');
  });

  it('reports the unpinned draft workflow as drifted, never wired, and names the pin step', async () => {
    // The draft ships the sentinel at both engine-ref lines. It is structurally correct but
    // not yet enforceable, so it is drifted for doctor. The old code read this as wired.
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ '.github/workflows/usabl-gate.yml': USABL_GATE_WORKFLOW }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(stateOf(reports, 'ci')).toBe('drifted');
    const step = byId(reports, 'ci').nextStep;
    expect(step).toContain('40-character');
    expect(step).toContain(ENGINE_REF_PLACEHOLDER);
  });

  it('reports a pinned workflow with a structural edit outside the engine ref as drifted', async () => {
    // A subtler drift than a wholesale rewrite: the workflow is pinned to a real SHA but a
    // non-ref line was hand-tuned. Only the engine-ref lines are variable, so this is drift.
    const tampered = PINNED_WORKFLOW.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted');
    const reports = await collectDoctorReport({
      fs: readOnlyFs({ '.github/workflows/usabl-gate.yml': tampered }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(stateOf(reports, 'ci')).toBe('drifted');
  });

  it('maps an unexpected fs read error to unknown, never wired and never a crash', async () => {
    // An EACCES on read is a genuine cannot-confirm signal. Recognition never fails toward
    // success, so the surface is unknown, and the whole report still renders.
    const reports = await collectDoctorReport({
      fs: fsFailingWith('EACCES'),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(stateOf(reports, 'config')).toBe('unknown');
    expect(byId(reports, 'config').nextStep.toLowerCase()).toContain('permission');
  });

  it('propagates a non-fs programmer error instead of masking it as unknown', async () => {
    // Load-bearing: a TypeError is a real bug, not a file-system failure. Swallowing it as
    // unknown would fail toward success and hide the defect. It must reach the cli catch-all.
    await expect(
      collectDoctorReport({
        fs: fsThrowingProgrammerError(),
        gh: GH_UNAVAILABLE,
        configPath: 'usabl.config.json',
      }),
    ).rejects.toThrow('programmer error');
  });
});

describe('runDoctor', () => {
  it('exits 0 for a bare repo even though every surface is unwired', async () => {
    const outcome = await runDoctor({
      fs: readOnlyFs({}),
      gh: GH_NOT_PROTECTED,
      configPath: 'usabl.config.json',
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.length).toBeGreaterThan(0);
  });

  it('exits 0 for a partially wired repo', async () => {
    const outcome = await runDoctor({
      fs: readOnlyFs({ 'usabl.config.json': VALID_CONFIG }),
      gh: GH_UNAVAILABLE,
      configPath: 'usabl.config.json',
    });
    expect(outcome.exitCode).toBe(0);
  });

  it('renders each surface label and states doctor mints no verdict', async () => {
    const outcome = await runDoctor({
      fs: readOnlyFs(FULLY_WIRED_FILES),
      gh: GH_VERIFIED,
      configPath: 'usabl.config.json',
    });
    expect(outcome.stdout.toLowerCase()).toContain('doctor');
    expect(outcome.stdout.toLowerCase()).toContain('no verdict');
    expect(outcome.stdout).toContain('[wired]');
  });
});

describe('formatDoctorReport neutralization', () => {
  it('neutralizes a file-derived config path carrying a control sequence', () => {
    const reports: SurfaceReport[] = [
      {
        id: 'config',
        label: 'usabl config',
        state: 'missing',
        nextStep: 'Run "usabl init" to create usabl\x1b[2Kspoof.config.json.',
      },
    ];
    const text = formatDoctorReport(reports);
    expect(text).not.toContain('\x1b');
    expect(text).toContain('spoof');
  });

  it('neutralizes a control-carrying config path end to end through collect and format', async () => {
    const evilPath = 'usabl\x1b[2Kspoof.config.json';
    const reports = await collectDoctorReport({
      fs: readOnlyFs({}),
      gh: GH_UNAVAILABLE,
      configPath: evilPath,
    });
    const text = formatDoctorReport(reports);
    expect(text).not.toContain('\x1b');
    expect(text).toContain('spoof');
  });

  it('neutralizes a label carrying a control sequence, not just the next step', () => {
    // Labels can embed a file-derived value (a surface path), so the format loop must
    // neutralize the label too. Without it, a crafted path in a label reaches the terminal.
    const reports: SurfaceReport[] = [
      { id: 'ci', label: 'ci gate\x1b[2Kworkflow', state: 'wired', nextStep: '' },
    ];
    const text = formatDoctorReport(reports);
    expect(text).not.toContain('\x1b');
    expect(text).toContain('workflow');
  });
});
