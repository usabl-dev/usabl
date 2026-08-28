/**
 * `run(deps, config)` is the whole engine sequencer: guard, cover, scan, gate, maybe receipt.
 * It never decides a verdict. The gate does. This file only sequences injected I/O.
 *
 * Guard runs first. Diverged working-tree floor and waiver bytes are not parsed,
 * because a crash would fail open (exit 4) instead of blocking as approval_required.
 * Affected UI still scans so mixed policy PRs keep accessibility findings.
 *
 * Coverage mapping comes from the planner shared by tests and production code.
 * A local fallback mapper is forbidden because it could hide unmapped UI as idle.
 *
 * No hidden filesystem, git, or browser. Callers pass Deps (real or `makeFakeDeps`).
 * Sampling is forbidden: every affected surface is scanned, or we do not claim verified.
 */
import type {
  Coverage,
  Deps,
  EvidenceFloor,
  FloorEntry,
  Finding,
  Result,
  ScreenScan,
  UsablConfig,
  Waiver,
  WaiverLedger,
} from './contracts/index.js';
import { computeCoverage } from './coverage/planner.js';
import { gate } from './gate/index.js';
import { mintReceipt } from './evidence/receipt.js';
import { loadRequirements } from './intake/load.js';
import { assertIso8601Utc } from './primitives/iso8601.js';
import { checkGuard } from './trust/guard.js';

const EMPTY_FLOOR: EvidenceFloor = { version: 1, entries: [] };

export interface RunOptions {
  changedFiles?: string[];
  trustedRef?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseFloorEntry(value: unknown): FloorEntry {
  if (!isRecord(value)) {
    throw new Error('evidence floor entry must be an object');
  }

  const screenId = value['screenId'];
  const layer = value['layer'];
  const rule = value['rule'];
  const elementKey = value['elementKey'];
  const identityBasis = value['identityBasis'];
  const count = value['count'];

  if (typeof screenId !== 'string') throw new Error('evidence floor entry screenId must be a string');
  if (typeof layer !== 'string') throw new Error('evidence floor entry layer must be a string');
  if (typeof rule !== 'string') throw new Error('evidence floor entry rule must be a string');
  if (elementKey !== null && typeof elementKey !== 'string') {
    throw new Error('evidence floor entry elementKey must be a string or null');
  }
  if (identityBasis !== 'name' && identityBasis !== 'structural' && identityBasis !== 'count') {
    throw new Error('evidence floor entry identityBasis must be name, structural, or count');
  }
  if (typeof count !== 'number') throw new Error('evidence floor entry count must be a number');

  return { screenId, layer, rule, elementKey, identityBasis, count };
}

function parseEvidenceFloor(value: unknown): EvidenceFloor {
  if (!isRecord(value)) {
    throw new Error('evidence floor must be an object');
  }
  if (value['version'] !== 1) {
    throw new Error('evidence floor version must be 1');
  }
  const entriesRaw = value['entries'];
  if (!Array.isArray(entriesRaw)) {
    throw new Error('evidence floor entries must be an array');
  }
  return { version: 1, entries: entriesRaw.map((entry) => parseFloorEntry(entry)) };
}

function parseWaiver(value: unknown): Waiver {
  if (!isRecord(value)) {
    throw new Error('waiver entry must be an object');
  }

  const rule = value['rule'];
  const surface = value['surface'];
  const scope = value['scope'];
  const reason = value['reason'];
  const owner = value['owner'];
  const approvedBy = value['approvedBy'];
  const created = value['created'];
  const expires = value['expires'];

  if (typeof rule !== 'string') throw new Error('waiver rule must be a string');
  if (typeof surface !== 'string') throw new Error('waiver surface must be a string');
  if (typeof scope !== 'string') throw new Error('waiver scope must be a string');
  if (typeof reason !== 'string') throw new Error('waiver reason must be a string');
  if (typeof owner !== 'string') throw new Error('waiver owner must be a string');
  if (typeof approvedBy !== 'string') throw new Error('waiver approvedBy must be a string');
  if (typeof created !== 'string') throw new Error('waiver created must be a string');
  if (typeof expires !== 'string') throw new Error('waiver expires must be a string');
  assertIso8601Utc(created, 'waiver created');
  assertIso8601Utc(expires, 'waiver expires');

  return { rule, surface, scope, reason, owner, approvedBy, created, expires };
}

function parseWaiverLedger(value: unknown): WaiverLedger {
  if (!isRecord(value)) {
    throw new Error('waiver ledger must be an object');
  }
  if (value['version'] !== 1) {
    throw new Error('waiver ledger version must be 1');
  }
  const waiversRaw = value['waivers'];
  if (!Array.isArray(waiversRaw)) {
    throw new Error('waiver ledger waivers must be an array');
  }
  return { version: 1, waivers: waiversRaw.map((waiver) => parseWaiver(waiver)) };
}

async function readJson(read: (path: string) => Promise<string | null>, path: string): Promise<unknown | null> {
  const raw = await read(path);
  if (raw === null) return null;
  return JSON.parse(raw);
}

export async function run(deps: Deps, config: UsablConfig, opts: RunOptions = {}): Promise<Result> {
  try {
    const changed = opts.changedFiles ?? (await deps.git.statusZ()).map((c) => c.path);
    const guardDivergedPaths = await checkGuard(deps, config, opts.trustedRef ?? 'HEAD');
    const coverageFs = overlayUntrustedRoutes(deps, guardDivergedPaths, opts.trustedRef);
    const discoveredCoverage = await computeCoverage(coverageFs, config, changed);
    const loadedRequirements = await loadRequirements(deps.fs, config);
    const intakePolicyPaths =
      loadedRequirements.ok
        ? []
        : [loadedRequirements.path ?? config.requirements ?? 'requirements'].filter((path) => path.length > 0);
    const policyDivergedPaths = [...new Set([...guardDivergedPaths, ...intakePolicyPaths])].sort();

    // Malformed intake cannot self-grade. The harness stays closed until policy is valid.
    // Guarded-file edits still scan affected UI so mixed PRs keep accessibility findings.
    const screens: ScreenScan[] = [];
    const canScan = loadedRequirements.ok && !discoveredCoverage.nothingToCheck;
    if (canScan) {
      for (const s of discoveredCoverage.affected) {
        screens.push(await deps.checkRunner.scan({ id: s.screenId, url: s.url }));
      }
    }
    const coverage: Coverage = {
      ...discoveredCoverage,
      gaps: [...discoveredCoverage.gaps, ...screens.flatMap((screen) => screen.gaps)],
    };
    const drafts = screens.flatMap((s) => s.drafts);

    const policyUntrusted = policyDivergedPaths.length > 0;
    const readTrustFile = (path: string): Promise<string | null> => {
      // Floor and waivers can be pinned to a trusted ref so a PR cannot claim
      // verified against acceptance bytes it just changed in the working tree.
      if (opts.trustedRef !== undefined) {
        return deps.git.show(opts.trustedRef, path);
      }
      if (policyUntrusted) {
        return Promise.resolve(null);
      }
      return deps.fs.readFile(path);
    };
    const floor = await readFloorOrEmpty(readTrustFile, policyUntrusted);
    const waivers = await readWaiversOrEmpty(readTrustFile, policyUntrusted);

    const gated = gate({ coverage, guardDivergedPaths: policyDivergedPaths, drafts, floor, waivers, now: deps.clock() });

    // Receipts are reserved for verified. Preview and model-judgment cannot mint one.
    const receipt =
      gated.verdict === 'verified'
        ? await mintReceipt(deps, config, {
            surfaces: ['cli'],
            checked: coverage.affected.map((a) => a.screenId),
            notCovered: coverage.unresolvedFiles,
            findingsSummary: summarize(gated.findings),
            activeWaivers: gated.findings.filter((f) => f.status === 'waived').length,
          })
        : null;

    return {
      schemaVersion: 'usabl.result.v1',
      verdict: gated.verdict,
      summary: gated.summary,
      screens,
      coverage,
      findings: gated.findings,
      receipt,
      dirtyGuardedPaths: policyDivergedPaths,
      exitCode: gated.exitCode,
      accessibilityVerdict: gated.accessibilityVerdict,
      accessibilityExitCode: gated.accessibilityExitCode,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Crash: disclose and fail open (exit 4). verdict is null because the gate never ran.
    // This is not idle (`nothingToCheck` is false). Never mint verified from a crash.
    return {
      schemaVersion: 'usabl.result.v1',
      verdict: null,
      summary: `unhandled error: ${message}`,
      screens: [],
      coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
      findings: [],
      receipt: null,
      dirtyGuardedPaths: [],
      exitCode: 4,
      accessibilityVerdict: null,
      accessibilityExitCode: 4,
    };
  }
}

async function readFloorOrEmpty(
  read: (path: string) => Promise<string | null>,
  policyUntrusted: boolean,
): Promise<EvidenceFloor> {
  try {
    const floorValue = await readJson(read, '.usabl-evidence.json');
    return floorValue === null ? EMPTY_FLOOR : parseEvidenceFloor(floorValue);
  } catch (err) {
    if (policyUntrusted) return EMPTY_FLOOR;
    throw err;
  }
}

async function readWaiversOrEmpty(
  read: (path: string) => Promise<string | null>,
  policyUntrusted: boolean,
): Promise<Waiver[]> {
  try {
    const ledgerValue = await readJson(read, '.usabl-waivers.json');
    return ledgerValue === null ? [] : parseWaiverLedger(ledgerValue).waivers;
  } catch (err) {
    if (policyUntrusted) return [];
    throw err;
  }
}

function overlayUntrustedRoutes(
  deps: Deps,
  guardDivergedPaths: string[],
  trustedRef: string | undefined,
): Deps['fs'] {
  // Coverage planning reads usabl.routes.json. If that file diverged, use the
  // trusted ref (or nothing) so a PR cannot widen its own blast radius.
  // usabl.config.json is loaded by the CLI before run() and is already listed
  // in dirtyGuardedPaths; substituting it here would not change scan targets.
  const routesDiverged = guardDivergedPaths.includes('usabl.routes.json');
  if (!routesDiverged) {
    return deps.fs;
  }
  return {
    glob: (patterns) => deps.fs.glob(patterns),
    readFile: async (path) => {
      if (path !== 'usabl.routes.json') {
        return deps.fs.readFile(path);
      }
      if (trustedRef !== undefined) {
        return deps.git.show(trustedRef, path);
      }
      return null;
    },
  };
}

function summarize(findings: Finding[]) {
  return {
    new: findings.filter((f) => f.status === 'new').length,
    carried: findings.filter((f) => f.status === 'carried').length,
    fixed: findings.filter((f) => f.status === 'fixed').length,
    unverified: findings.filter((f) => f.confidence === 'unverified').length,
  };
}
