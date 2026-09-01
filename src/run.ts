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
  Finding,
  Result,
  ScreenScan,
  UsablConfig,
  Waiver,
  WaiverLedger,
} from './contracts/index.js';
import { computeCoverage } from './coverage/planner.js';
import { parseDocsManifest, type DocsManifest } from './coverage/docs-manifest.js';
import { computeDocsCoverage } from './coverage/docs-planner.js';
import { mapFindingToSource, type DocsPageClosure } from './docs/source-map.js';
import { gate } from './gate/index.js';
import { mintReceipt } from './evidence/receipt.js';
import { parseEvidenceFloor } from './evidence/floor.js';
import { parseUsablConfig } from './intake/config.js';
import { loadRequirements } from './intake/load.js';
import { overlayRequirementsFs } from './intake/overlay-fs.js';
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

// Exported so the read-only doctor projection can report waiver-ledger parse health without
// re-implementing a weaker validator. run() stays the only caller that acts on the result.
export function parseWaiverLedger(value: unknown): WaiverLedger {
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
    const scanConfig = await scanConfigForCoverage(deps, config, guardDivergedPaths, opts.trustedRef);
    const coverageFs = overlayUntrustedManifests(deps, guardDivergedPaths, opts.trustedRef);
    const discoveredCoverage = await computeCoverage(coverageFs, scanConfig, changed);
    const docsManifest = await parseDocsManifest(coverageFs);
    const docsCoverage = computeDocsCoverage(docsManifest, changed);
    const affected = [...discoveredCoverage.affected, ...docsCoverage.affected];
    const nothingToCheck = discoveredCoverage.nothingToCheck && docsCoverage.nothingToCheck;
    const intakeFs = overlayRequirementsFs(deps.fs, deps.git, scanConfig, opts.trustedRef);
    const loadedRequirements = await loadRequirements(intakeFs, scanConfig);
    const intakePolicyPaths =
      loadedRequirements.ok
        ? []
        : [loadedRequirements.path ?? config.requirements ?? 'requirements'].filter((path) => path.length > 0);
    const policyDivergedPaths = [...new Set([...guardDivergedPaths, ...intakePolicyPaths])].sort();

    // Malformed intake cannot self-grade. The harness stays closed until policy is valid.
    // Guarded-file edits still scan affected UI so mixed PRs keep accessibility findings.
    const screens: ScreenScan[] = [];
    const canScan = loadedRequirements.ok && !nothingToCheck;
    if (canScan) {
      for (const s of affected) {
        screens.push(await deps.checkRunner.scan({
          id: s.screenId,
          url: s.url,
          ...(s.profile !== undefined ? { profile: s.profile } : {}),
        }));
      }
    }
    const coverage: Coverage = {
      ...discoveredCoverage,
      affected,
      nothingToCheck,
      unresolvedFiles: [...discoveredCoverage.unresolvedFiles, ...docsCoverage.unresolvedFiles],
      gaps: [...discoveredCoverage.gaps, ...docsCoverage.gaps, ...screens.flatMap((screen) => screen.gaps)],
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

    // Enrich docs findings so they speak the author's markup: source file, AsciiDoc construct, and a
    // syntax-aware fix. This runs after the gate on purpose. It reads source, never a verdict, and
    // never changes identity, status, or the floor. Source is read from the working tree (deps.fs),
    // where the author fixes it, even when the manifest itself was read from a trusted ref.
    const findings = await enrichDocsFindings(gated.findings, docsManifest, deps.fs);

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

    // Count previously floored barriers that this run confirms are resolved. A barrier is
    // confirmed resolved only when its screen was scanned cleanly (no coverage gaps) AND
    // the barrier was not observed. A gapped screen produces no drafts, so an absent barrier
    // there is unproven (not resolved). Counting it would claim progress that did not happen.
    const cleanlyScannedScreens = new Set(
      screens.filter((screen) => screen.gaps.length === 0).map((screen) => screen.screenId),
    );
    const paidDownCount = gated.findings.filter(
      (f) => f.status === 'fixed' && cleanlyScannedScreens.has(f.screenId),
    ).length;

    return {
      schemaVersion: 'usabl.result.v1',
      verdict: gated.verdict,
      summary: gated.summary,
      screens,
      coverage,
      findings,
      receipt,
      dirtyGuardedPaths: policyDivergedPaths,
      exitCode: gated.exitCode,
      accessibilityVerdict: gated.accessibilityVerdict,
      accessibilityExitCode: gated.accessibilityExitCode,
      paidDownCount,
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
      paidDownCount: 0,
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

async function scanConfigForCoverage(
  deps: Deps,
  config: UsablConfig,
  guardDivergedPaths: string[],
  trustedRef: string | undefined,
): Promise<UsablConfig> {
  // Working-tree config URLs are untrusted when config diverged. Scan the
  // trusted-ref document so a policy PR cannot point the CI browser at a new origin.
  if (!guardDivergedPaths.includes('usabl.config.json') || trustedRef === undefined) {
    return config;
  }
  const raw = await deps.git.show(trustedRef, 'usabl.config.json');
  if (raw === null) {
    return { ...config, surfaces: [], uiFileGlobs: [] };
  }
  try {
    return parseUsablConfig(raw);
  } catch {
    return { ...config, surfaces: [], uiFileGlobs: [] };
  }
}

function overlayUntrustedManifests(
  deps: Deps,
  guardDivergedPaths: string[],
  trustedRef: string | undefined,
): Deps['fs'] {
  // Coverage planning reads usabl.routes.json and usabl.docs.json. Both control
  // scan targets (routes controls app scan targets, docs controls the docs scan surface).
  // If either file diverged, use the trusted ref (or nothing) so a PR cannot steer scans
  // at attacker-chosen URLs.
  const overlaidManifests = ['usabl.routes.json', 'usabl.docs.json'];
  const divergedManifests = overlaidManifests.filter((path) => guardDivergedPaths.includes(path));
  if (divergedManifests.length === 0) {
    return deps.fs;
  }
  const divergedSet = new Set(divergedManifests);
  return {
    glob: (patterns) => deps.fs.glob(patterns),
    readFile: async (path) => {
      if (!divergedSet.has(path)) {
        return deps.fs.readFile(path);
      }
      if (trustedRef !== undefined) {
        return deps.git.show(trustedRef, path);
      }
      return null;
    },
  };
}

// Attach a source mapping to every finding on a docs page (its screenId matches a manifest pageId).
// App findings and docs findings whose page cannot be resolved pass through unchanged. mapFindingToSource
// fails open, so a missing or unreadable source yields a fallback mapping, never a throw.
async function enrichDocsFindings(
  findings: Finding[],
  docsManifest: DocsManifest | null,
  fs: Deps['fs'],
): Promise<Finding[]> {
  if (docsManifest === null) {
    return findings;
  }
  const closureByPageId = new Map<string, DocsPageClosure>();
  for (const page of docsManifest.pages) {
    closureByPageId.set(page.pageId, { assemblyFile: page.assemblyFile, sources: page.sources });
  }
  const enriched: Finding[] = [];
  for (const finding of findings) {
    const closure = closureByPageId.get(finding.screenId);
    if (closure === undefined) {
      enriched.push(finding);
      continue;
    }
    const docsSource = await mapFindingToSource(finding, closure, fs);
    enriched.push({ ...finding, docsSource });
  }
  return enriched;
}

function summarize(findings: Finding[]) {
  return {
    new: findings.filter((f) => f.status === 'new').length,
    carried: findings.filter((f) => f.status === 'carried').length,
    fixed: findings.filter((f) => f.status === 'fixed').length,
    unverified: findings.filter((f) => f.confidence === 'unverified').length,
  };
}
