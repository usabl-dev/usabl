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
import { computeGuardDivergence } from './guard/index.js';
import { gate } from './gate/index.js';
import { mintReceipt } from './evidence/receipt.js';

const EMPTY_FLOOR: EvidenceFloor = { version: 1, entries: [] };

function matchGlob(pattern: string, path: string): boolean {
  const rx = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\x00/g, '.*') +
      '$',
  );
  return rx.test(path);
}

/** Direct config-mapping coverage. Phase 3 replaces this with route-graph discovery. */
function computeCoverage(config: UsablConfig, changed: string[]): Coverage {
  const uiFiles = changed.filter((f) => config.uiFileGlobs.some((g) => matchGlob(g, f)));
  if (uiFiles.length === 0) {
    return { changedFiles: changed, affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true };
  }
  const affected = config.surfaces
    .filter((s) => s.files.some((sf) => uiFiles.includes(sf)))
    .map((s) => ({ screenId: s.id, url: s.url, provenance: 'manual' as const }));
  const mapped = new Set(config.surfaces.flatMap((s) => s.files));
  const unresolvedFiles = uiFiles.filter((f) => !mapped.has(f));
  return { changedFiles: changed, affected, unresolvedFiles, gaps: [], nothingToCheck: false };
}

async function readJson<T>(deps: Deps, path: string): Promise<T | null> {
  const raw = await deps.fs.readFile(path);
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

export async function run(deps: Deps, config: UsablConfig): Promise<Result> {
  try {
    const changed = (await deps.git.statusZ()).map((c) => c.path);
    const coverage = computeCoverage(config, changed);
    const guardDivergedPaths = await computeGuardDivergence(deps, config.guardedPaths);

    // Scan each affected surface fully (never sample).
    const screens: ScreenScan[] = [];
    if (guardDivergedPaths.length === 0 && !coverage.nothingToCheck) {
      for (const s of coverage.affected) {
        screens.push(await deps.checkRunner.scan({ id: s.screenId, url: s.url }));
      }
    }
    const drafts = screens.flatMap((s) => s.drafts);

    const floor = (await readJson<EvidenceFloor>(deps, '.usabl-evidence.json')) ?? EMPTY_FLOOR;
    const ledger = await readJson<WaiverLedger>(deps, '.usabl-waivers.json');
    const waivers: Waiver[] = ledger?.waivers ?? [];

    const gated = gate({ coverage, guardDivergedPaths, drafts, floor, waivers, now: deps.clock() });

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
      dirtyGuardedPaths: guardDivergedPaths,
      exitCode: gated.exitCode,
    };
  } catch (err) {
    // Fail open with disclosure (§9), never a silent pass.
    return {
      schemaVersion: 'usabl.result.v1',
      verdict: null,
      summary: `unhandled error: ${(err as Error).message}`,
      screens: [],
      coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
      findings: [],
      receipt: null,
      dirtyGuardedPaths: [],
      exitCode: 4,
    };
  }
}

function summarize(findings: Finding[]) {
  return {
    new: findings.filter((f) => f.status === 'new').length,
    carried: findings.filter((f) => f.status === 'carried').length,
    fixed: findings.filter((f) => f.status === 'fixed').length,
    unverified: findings.filter((f) => f.confidence === 'unverified').length,
  };
}
