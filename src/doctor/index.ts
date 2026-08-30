/**
 * `usabl doctor`: a read-only self-check that projects what is wired, missing, drifted, or
 * unknown across the usabl integration surfaces.
 * This unit is read-only and mints NO verdict. It never writes a file, never calls the gate,
 * and never reads a Result. It reuses the install family's recognition predicates in plan
 * (read-only) mode instead of re-deriving weaker checks, because a re-implemented recognizer
 * could fail toward success. Recognition never fails toward success here: a surface it cannot
 * positively confirm reports missing, drifted, or unknown, never "wired". unknown is a
 * first-class state for "cannot positively confirm" and is never collapsed into wired.
 * runDoctor always exits 0 when it renders a report, because a missing surface is information,
 * not a doctor failure, and doctor must never become a second verdict authority.
 */
import type { InstallFs } from '../install/index.js';
import { planOverlay } from '../install/overlay.js';
import { planClaude } from '../install/claude.js';
import { planCi } from '../install/ci.js';
import { verifyBranchRule, type GhReader } from '../install/branch-rule.js';
import { parseConfiguredManifest } from '../coverage/route-manifest.js';
import { parseUsablConfig } from '../intake/config.js';
import { parseEvidenceFloor } from '../evidence/floor.js';
import { EVIDENCE_FLOOR_PATH } from '../baseline/index.js';
import { parseWaiverLedger } from '../run.js';
import { neutralize } from '../primitives/neutralize.js';

// The waiver ledger path the gate reads. There is no shared constant for it today (run.ts,
// guard.ts, and init all use the literal), so doctor names it locally rather than invent a
// weaker presence-only waiver check.
const WAIVERS_PATH = '.usabl-waivers.json';

// Four states, and unknown is first class. wired is a positive confirmation. missing is a
// confident absence. drifted is present-but-not-what-usabl-expects. unknown is "cannot
// positively confirm", and it is never mapped from anything but a genuine cannot-confirm
// signal. A recognizer that is unsure lands here, never on wired.
export type SurfaceState = 'wired' | 'missing' | 'drifted' | 'unknown';

export interface SurfaceReport {
  id: string;
  label: string;
  state: SurfaceState;
  // The one honest next step for this surface. Empty when wired (no action). May embed a
  // file-derived value such as the operator-supplied config path, so formatDoctorReport
  // neutralizes it at print time.
  nextStep: string;
}

export interface DoctorDeps {
  // Read-only by contract: the install plan functions only call readFile and glob. Pass an
  // InstallFs whose writeFile throws so a doctor path that ever tried to write fails loudly.
  fs: InstallFs;
  gh: GhReader;
  // The config path to inspect. Defaults to usabl.config.json at the call site, or whatever
  // the operator passed via --config.
  configPath: string;
}

async function collectConfig(deps: DoctorDeps): Promise<SurfaceReport> {
  // Read the bytes directly. loadConfig throws on a missing file, which would crash doctor,
  // so doctor reads with the null-on-missing fs and parses in a try/catch of its own.
  const raw = await deps.fs.readFile(deps.configPath);
  if (raw === null) {
    return {
      id: 'config',
      label: 'usabl config',
      state: 'missing',
      nextStep: `No usabl config. Run "usabl init" to create ${deps.configPath}.`,
    };
  }
  try {
    parseUsablConfig(raw);
  } catch {
    return {
      id: 'config',
      label: 'usabl config',
      state: 'drifted',
      nextStep: `${deps.configPath} is present but does not parse as a usabl config. Fix the JSON, or re-run "usabl init".`,
    };
  }
  return { id: 'config', label: 'usabl config', state: 'wired', nextStep: '' };
}

async function collectRoutes(deps: DoctorDeps): Promise<SurfaceReport> {
  // Doctor reports the manifest's own presence and parse health only. Deep routes-vs-app
  // drift is "usabl drift routes"' job and carries an unparseable-router hazard doctor must
  // not duplicate, so even a wired manifest points the operator at the deeper check.
  let manifest;
  try {
    manifest = await parseConfiguredManifest(deps.fs);
  } catch {
    return {
      id: 'routes',
      label: 'route manifest (usabl.routes.json)',
      state: 'drifted',
      nextStep: 'usabl.routes.json is present but does not parse. Fix the JSON so route coverage can be planned.',
    };
  }
  if (manifest === null) {
    return {
      id: 'routes',
      label: 'route manifest (usabl.routes.json)',
      state: 'missing',
      nextStep: 'No usabl.routes.json. Run "usabl init" to create the route manifest.',
    };
  }
  return {
    id: 'routes',
    label: 'route manifest (usabl.routes.json)',
    state: 'wired',
    nextStep: 'Present and parses. For the deeper check, run "usabl drift routes" to compare it against the app router.',
  };
}

async function collectEvidenceFloor(deps: DoctorDeps): Promise<SurfaceReport> {
  const raw = await deps.fs.readFile(EVIDENCE_FLOOR_PATH);
  if (raw === null) {
    return {
      id: 'evidence-floor',
      label: `evidence floor (${EVIDENCE_FLOOR_PATH})`,
      state: 'missing',
      nextStep: `No evidence floor. Run "usabl baseline" to record current debt so only new barriers gate.`,
    };
  }
  try {
    parseEvidenceFloor(JSON.parse(raw));
  } catch {
    return {
      id: 'evidence-floor',
      label: `evidence floor (${EVIDENCE_FLOOR_PATH})`,
      state: 'drifted',
      nextStep: `${EVIDENCE_FLOOR_PATH} is present but does not parse as an evidence floor. Fix it, or re-run "usabl baseline".`,
    };
  }
  return { id: 'evidence-floor', label: `evidence floor (${EVIDENCE_FLOOR_PATH})`, state: 'wired', nextStep: '' };
}

async function collectWaivers(deps: DoctorDeps): Promise<SurfaceReport> {
  const raw = await deps.fs.readFile(WAIVERS_PATH);
  if (raw === null) {
    return {
      id: 'waivers',
      label: `waiver ledger (${WAIVERS_PATH})`,
      state: 'missing',
      nextStep: `No waiver ledger. Add ${WAIVERS_PATH} only if you need to time-box an accepted barrier.`,
    };
  }
  try {
    parseWaiverLedger(JSON.parse(raw));
  } catch {
    return {
      id: 'waivers',
      label: `waiver ledger (${WAIVERS_PATH})`,
      state: 'drifted',
      nextStep: `${WAIVERS_PATH} is present but does not parse as a waiver ledger. Fix it before the gate runs.`,
    };
  }
  return { id: 'waivers', label: `waiver ledger (${WAIVERS_PATH})`, state: 'wired', nextStep: '' };
}

async function collectOverlay(deps: DoctorDeps): Promise<SurfaceReport> {
  // already-wired is the only wired mapping. A config present but not wired is drifted, and
  // no config at all is missing. This drives off the same string-aware recognizer install
  // uses, so a commented-out or quoted mention never reads as wired.
  const plan = await planOverlay(deps.fs);
  const label = 'vite overlay plugin';
  if (plan.action === 'already-wired') {
    return { id: 'overlay', label, state: 'wired', nextStep: '' };
  }
  if (plan.action === 'refuse') {
    return {
      id: 'overlay',
      label,
      state: 'drifted',
      nextStep: `${plan.path} is present but does not wire the overlay. Run "usabl install --overlay" for the exact two lines, or add them by hand.`,
    };
  }
  return {
    id: 'overlay',
    label,
    state: 'missing',
    nextStep: 'No Vite config wires the overlay. Run "usabl install --overlay" to write a draft.',
  };
}

async function collectStopHook(deps: DoctorDeps): Promise<SurfaceReport> {
  // already-wired is the only wired mapping. update means a usabl hook still points at the
  // retired dist path (drifted). write means the file is absent (missing). refuse means an
  // unparseable, foreign, or ambiguous Stop hook that usabl cannot recognize: doctor cannot
  // positively confirm, so it is unknown, never wired.
  const plan = await planClaude(deps.fs);
  const label = 'claude stop hook (.claude/settings.json)';
  if (plan.action === 'already-wired') {
    return { id: 'stop-hook', label, state: 'wired', nextStep: '' };
  }
  if (plan.action === 'update') {
    return {
      id: 'stop-hook',
      label,
      state: 'drifted',
      nextStep: 'The usabl Stop hook points at the retired dist path. Run "usabl install --claude" to update it to "npx usabl stop-hook".',
    };
  }
  if (plan.action === 'write') {
    return {
      id: 'stop-hook',
      label,
      state: 'missing',
      nextStep: 'No .claude/settings.json. Run "usabl install --claude" to wire the usabl Stop hook.',
    };
  }
  return {
    id: 'stop-hook',
    label,
    state: 'unknown',
    nextStep: 'usabl cannot confirm the Stop hook: the file has a Stop hook usabl does not recognize or cannot parse. Reconcile it by hand; see "usabl install --claude".',
  };
}

async function collectCi(deps: DoctorDeps): Promise<SurfaceReport> {
  // already-wired is the only wired mapping. refuse means an existing workflow whose bytes
  // differ from the usabl draft (drifted). write means it is absent (missing).
  const plan = await planCi(deps.fs);
  const label = 'ci gate workflow (.github/workflows/usabl-gate.yml)';
  if (plan.action === 'already-wired') {
    return { id: 'ci', label, state: 'wired', nextStep: '' };
  }
  if (plan.action === 'refuse') {
    return {
      id: 'ci',
      label,
      state: 'drifted',
      nextStep: 'A gate workflow is present but differs from the usabl draft. Run "usabl install --ci" to see where, and reconcile by hand.',
    };
  }
  return {
    id: 'ci',
    label,
    state: 'missing',
    nextStep: 'No usabl gate workflow. Run "usabl install --ci" to write the draft.',
  };
}

async function collectBranchRule(deps: DoctorDeps): Promise<SurfaceReport> {
  // verified is the only wired mapping. not-applied is a confident absence (missing).
  // cannot-verify (gh missing, ambiguous 404, unreadable response) is unknown, because
  // doctor cannot positively confirm the setting and must not guess it is present or absent.
  const result = await verifyBranchRule(deps.gh);
  const label = 'branch protection (main requires usabl-policy)';
  if (result.action === 'verified') {
    return { id: 'branch-rule', label, state: 'wired', nextStep: '' };
  }
  if (result.action === 'not-applied') {
    return {
      id: 'branch-rule',
      label,
      state: 'missing',
      nextStep: 'The main branch does not require the usabl-policy check. Run "usabl install --branch-rule" for the exact setting.',
    };
  }
  return {
    id: 'branch-rule',
    label,
    state: 'unknown',
    nextStep: 'usabl cannot confirm branch protection (gh unavailable, or the read was inconclusive). Verify by hand; see "usabl install --branch-rule".',
  };
}

export async function collectDoctorReport(deps: DoctorDeps): Promise<SurfaceReport[]> {
  // Order mirrors the slice: config, routes, evidence floor, waivers, overlay, stop hook,
  // ci workflow, branch rule. Each collector is self-contained health logic with no printing,
  // so tests can target the states directly. Only genuine internal errors propagate; every
  // recognized state (including drifted and unknown) is returned, not thrown.
  return [
    await collectConfig(deps),
    await collectRoutes(deps),
    await collectEvidenceFloor(deps),
    await collectWaivers(deps),
    await collectOverlay(deps),
    await collectStopHook(deps),
    await collectCi(deps),
    await collectBranchRule(deps),
  ];
}

export function formatDoctorReport(reports: SurfaceReport[]): string {
  const counts: Record<SurfaceState, number> = { wired: 0, missing: 0, drifted: 0, unknown: 0 };
  for (const report of reports) {
    counts[report.state] += 1;
  }
  const lines: string[] = [
    `usabl doctor: ${counts.wired} wired, ${counts.missing} missing, ${counts.drifted} drifted, ${counts.unknown} unknown`,
    'doctor is a projection: it reports what is wired and mints no verdict. The gate is the only verdict.',
    '',
  ];
  for (const report of reports) {
    lines.push(`  [${report.state}] ${report.label}`);
    // nextStep can embed a file-derived value (for example the --config path), so neutralize
    // it at this egress. Authored labels carry no derived content, so they print as-is.
    const step = report.nextStep.length > 0 ? neutralize(report.nextStep) : 'no action';
    lines.push(`      ${step}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function runDoctor(deps: DoctorDeps): Promise<{ exitCode: 0; stdout: string }> {
  // Always exit 0 when a report renders. Surface state is information, not a doctor verdict,
  // so the count of missing, drifted, or unknown surfaces never changes the exit code. A
  // genuine internal error throws and falls through to the cli-bin catch-all (exit 4).
  const reports = await collectDoctorReport(deps);
  return { exitCode: 0, stdout: formatDoctorReport(reports) };
}
