/**
 * `usabl brief`: what an agent reads before it starts a task. It says which screens the task's
 * files reach, which checks apply to each screen and which do not and why, and what counts as
 * done.
 *
 * It is measurement. It mints no verdict and no receipt, never calls the gate, never reads a
 * verdict, and never opens a browser, so no page text is involved. Screens come from the same
 * planners run() calls, with the same inputs a local run gives them, joined in the same order,
 * and the checks come from the same provider list the check runner is built with. Nothing here
 * maps a file to a screen by itself.
 *
 * Policy is read from the working tree, the way a local run reads it. A local run also checks the
 * guarded files against HEAD and reads a routes or docs manifest that differs from HEAD as missing,
 * and the brief does the same and says so in a disclosure. CI judges a pull request on the trusted
 * ref, so a brief for a task that edits policy can differ from what the gate decides there. This
 * module has no path that reads policy from a trusted ref, and none that reads it from the pull
 * request tree in CI.
 */
import type {
  AffectedScreen,
  Coverage,
  CoverageGap,
  Deps,
  FsGlob,
  GitReader,
  PlannedScreen,
  Provider,
  RequirementBundle,
  UsablConfig,
} from '../contracts/index.js';
import { computeCoverage } from '../coverage/planner.js';
import { parseDocsManifest, type DocsManifest } from '../coverage/docs-manifest.js';
import { computeDocsCoverage, type DocsCoverage } from '../coverage/docs-planner.js';
import { DONE_CONDITIONS } from '../coverage/completeness.js';
import { loadRequirements } from '../intake/load.js';
import { overlayRequirementsFs } from '../intake/overlay-fs.js';
import { unknownSurfaceGapsForRun } from '../intake/requirement-surfaces.js';
import { plannedApplicability } from '../providers/applicability.js';
import { makeScanProviders, providerProves, PROVIDER_PROVES } from '../providers/core-stack.js';
import { makeEngineProviders } from '../providers/engines/index.js';
import { DEQUE_PROVIDER_ID } from '../providers/engines/deque.js';
import { EVINCED_PROVIDER_ID } from '../providers/engines/evinced.js';
import { scrubOutboundData } from '../surfaces/scrub.js';
import { checkGuard } from '../trust/guard.js';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { operatorPath } from '../intake/config-error.js';

export interface BriefCheck {
  id: string;
  applies: boolean;
  proves: string;
  why?: string;
}

export interface BriefReach {
  // The changed file that reaches the screen. Null only when no single changed file reaches it on
  // its own and the change as a whole does.
  file: string | null;
  via: string;
}

export interface BriefScreen {
  id: string;
  url: string;
  reachedBy: BriefReach[];
  checks: BriefCheck[];
  needsLiveScan: boolean;
}

export interface Brief {
  version: 1;
  policySource: 'working tree';
  files: string[];
  nothingToCheck: boolean;
  screens: BriefScreen[];
  unresolved: Array<{ file: string; why: string }>;
  // What the reader must know to read the brief right, such as a manifest a local run reads as
  // missing because it differs from HEAD.
  disclosures: string[];
  // Planning gaps that name no changed file, such as a route the router fallback could not read
  // or a requirement whose screen does not exist. The gate sees each of them as a coverage gap.
  gaps: Array<{ ref: string; why: string }>;
  done: string[];
}

export interface BriefInput {
  fs: FsGlob;
  git: Pick<GitReader, 'show' | 'statusZ' | 'lsFiles' | 'lsFilesUnder'>;
  config: UsablConfig;
  // The task's files. Absent means the changed files git reports, the same list a local
  // `usabl check` plans from.
  changedFiles?: string[];
}

/**
 * Above this many changed files the brief does not plan each file on its own. Each of those plans
 * builds the import graph again, so the cost grows with the size of the change. Past the limit a
 * screen lists only the file the joined plan kept, and a disclosure says so.
 */
export const PER_FILE_REACH_LIMIT = 50;

// The engines usabl knows. One that the config does not turn on has no provider, and the brief
// still names it so an agent does not assume it runs.
const KNOWN_ENGINE_IDS: readonly string[] = [DEQUE_PROVIDER_ID, EVINCED_PROVIDER_ID];
const ENGINE_OFF = 'not enabled in config';

// The ref a local run reads the workspace manifests at and checks the guarded files against.
// run() uses the same one when no trusted ref is given.
const LOCAL_REF = 'HEAD';

// The manifests that choose scan targets. A local run reads one that differs from HEAD as missing.
const SCAN_TARGET_MANIFESTS: readonly string[] = ['usabl.routes.json', 'usabl.docs.json'];

function manifestDisclosure(path: string): string {
  return `${path} differs from HEAD; a local check reads it as missing until it is committed, and CI needs approval for it.`;
}

/**
 * The file system a local run plans coverage with. The overlay in run.ts is private to it, so this
 * is the same rule built again from the guard's answer: with no trusted ref, a routes or docs
 * manifest that differs from HEAD reads as missing, so a task cannot point the scan at screens by
 * editing the manifest, and every other file reads from the working tree.
 */
function localCoverageFs(fs: FsGlob, divergedPaths: readonly string[]): { fs: FsGlob; hidden: string[] } {
  const hidden = SCAN_TARGET_MANIFESTS.filter((path) => divergedPaths.includes(path));
  if (hidden.length === 0) {
    return { fs, hidden };
  }
  return {
    fs: {
      glob: (patterns) => fs.glob(patterns),
      readFile: async (path) => (hidden.includes(path) ? null : fs.readFile(path)),
    },
    hidden,
  };
}

export type TaskFiles = { ok: true; files: string[] } | { ok: false; message: string };

/**
 * The task's files written the way git writes changed paths: relative to the repository root, with
 * no "./" and no doubled slash, in the order given, each once. The planners match these strings
 * against globs and surface files, so "./src/App.tsx" or an absolute path would otherwise map to
 * nothing and read as a file no screen reaches. A relative path is read from `cwd`, the way a shell
 * reads it. A path outside the repository is refused, because no screen of this repository can be
 * reached by it, and the refusal names it.
 */
export function normalizeTaskFiles(files: readonly string[], place: { root: string; cwd: string }): TaskFiles {
  const out: string[] = [];
  for (const file of files) {
    const absolute = resolve(place.cwd, file);
    const inRepo = relative(place.root, absolute).split(sep).join('/');
    if (inRepo === '' || inRepo === '..' || inRepo.startsWith('../') || isAbsolute(inRepo)) {
      return {
        ok: false,
        message:
          `refused: --files names ${operatorPath(file)}, which is outside the repository. ` +
          'Name each file by its path inside the repository, such as src/App.tsx.',
      };
    }
    out.push(posix.normalize(inRepo));
  }
  return { ok: true, files: [...new Set(out)] };
}

/** The app and docs plans for a list of changed files, joined the way run() joins them. */
interface JoinedPlan {
  affected: AffectedScreen[];
  nothingToCheck: boolean;
  unresolvedFiles: string[];
  gaps: CoverageGap[];
}

async function planFor(
  fs: FsGlob,
  config: UsablConfig,
  changed: string[],
  docsManifest: DocsManifest | null,
  trustedRead: (file: string) => Promise<string | null>,
): Promise<JoinedPlan> {
  const discovered: Coverage = await computeCoverage(fs, config, changed, docsManifest, trustedRead);
  const docs: DocsCoverage = computeDocsCoverage(docsManifest, changed);
  return {
    affected: [...discovered.affected, ...docs.affected],
    nothingToCheck: discovered.nothingToCheck && docs.nothingToCheck,
    unresolvedFiles: [...discovered.unresolvedFiles, ...docs.unresolvedFiles],
    gaps: [...discovered.gaps, ...docs.gaps],
  };
}

function viaOf(screen: AffectedScreen): string {
  switch (screen.provenance) {
    case 'route-graph':
      return `imported by the route entry ${screen.importChain?.[0] ?? 'file'}`;
    case 'manual':
      return 'surface files';
    case 'docs-manifest':
      return 'docs page sources';
    case 'wide-blast':
      if (screen.reason !== undefined) return 'dependency change';
      return screen.profile === 'docs' ? 'docs shared glob' : 'wide blast glob';
  }
}

function checksFor(providers: Provider[], screen: PlannedScreen): BriefCheck[] {
  const checks: BriefCheck[] = providers.map((provider) => {
    const proves = providerProves(provider);
    if (proves === null) {
      // A check the brief cannot describe is a check an agent would not know to aim at. Refuse
      // rather than print a guess.
      throw new Error(`usabl brief has no description for the check ${provider.id}`);
    }
    const plan = plannedApplicability(provider, screen);
    return { id: provider.id, applies: plan.applies, proves, ...(plan.why === undefined ? {} : { why: plan.why }) };
  });
  const present = new Set(providers.map((provider) => provider.id));
  for (const id of KNOWN_ENGINE_IDS) {
    if (!present.has(id)) {
      checks.push({ id, applies: false, proves: PROVIDER_PROVES[id] ?? id, why: ENGINE_OFF });
    }
  }
  return checks;
}

function doneFor(nothingToCheck: boolean, screens: BriefScreen[]): string[] {
  if (nothingToCheck) {
    return [DONE_CONDITIONS.nothingToCheck, DONE_CONDITIONS.approvals];
  }
  const done: string[] = [
    DONE_CONDITIONS.noBlockingFailure,
    DONE_CONDITIONS.noUnconfirmedFinding,
    DONE_CONDITIONS.coverageComplete,
    DONE_CONDITIONS.approvals,
  ];
  if (screens.some((screen) => screen.needsLiveScan)) {
    done.push(DONE_CONDITIONS.liveScan);
  }
  return done;
}

/**
 * The brief for a list of changed files. Throws when the configuration, a manifest, or the
 * requirements cannot be read, because a brief built on policy usabl could not read would
 * describe checks the gate will not run.
 */
export async function makeBrief(input: BriefInput): Promise<Brief> {
  const { fs, git, config } = input;
  const changed = input.changedFiles ?? (await git.statusZ()).map((entry) => entry.path);
  const trustedRead = (file: string): Promise<string | null> => git.show(LOCAL_REF, file);

  const requirementsFs = overlayRequirementsFs(fs, git, config, undefined);
  const loaded = await loadRequirements(requirementsFs, config);
  if (!loaded.ok) {
    throw new Error(`usabl could not load the design requirements: ${loaded.reason}`);
  }
  const requirements: RequirementBundle = loaded.bundle;

  // The guard reads only the file system and git, compares, and decides nothing. Its answer here
  // only says which manifests the local run would read as missing.
  const guardDeps = { fs, git } as unknown as Deps;
  const diverged = await checkGuard(guardDeps, config, LOCAL_REF);
  const coverage = localCoverageFs(fs, diverged);
  const coverageFs = coverage.fs;

  const docsManifest = await parseDocsManifest(coverageFs);
  const plan = await planFor(coverageFs, config, changed, docsManifest, trustedRead);

  // Which changed files reach each screen. Each file is planned on its own by the same planners,
  // so a screen lists every file that reaches it. The joined plan keeps only the first one. One
  // changed file needs no second plan: it is the only file that can reach anything. Past the limit
  // the joined plan's own reach is used.
  const reachers = new Map<string, BriefReach[]>();
  const disclosures = coverage.hidden.map(manifestDisclosure);
  const perFile = changed.length > 1 && changed.length <= PER_FILE_REACH_LIMIT;
  if (changed.length === 1) {
    for (const screen of plan.affected) {
      reachers.set(screen.screenId, [{ file: changed[0] ?? null, via: viaOf(screen) }]);
    }
  } else if (!perFile) {
    for (const screen of plan.affected) {
      reachers.set(screen.screenId, [{ file: screen.importChain?.[1] ?? null, via: viaOf(screen) }]);
    }
    if (plan.affected.length > 0) {
      disclosures.push(`reachedBy lists at most one file per screen because the change has ${changed.length} files.`);
    }
  }
  for (const file of perFile ? changed : []) {
    const single = await planFor(coverageFs, config, [file], docsManifest, trustedRead);
    for (const screen of single.affected) {
      const list = reachers.get(screen.screenId) ?? [];
      list.push({ file, via: viaOf(screen) });
      reachers.set(screen.screenId, list);
    }
  }

  const providers: Provider[] = [
    ...makeScanProviders(requirements),
    ...makeEngineProviders(config.engines),
  ];

  // A check that needs a live page cannot be met by a static-only run.
  const live = new Set(providers.filter((provider) => provider.capabilities.includes('live')).map((p) => p.id));
  const screens: BriefScreen[] = plan.affected.map((screen) => {
    const planned: PlannedScreen = { id: screen.screenId, profile: screen.profile ?? 'app' };
    const checks = checksFor(providers, planned);
    return {
      id: screen.screenId,
      url: screen.url,
      reachedBy: reachers.get(screen.screenId) ?? [{ file: null, via: viaOf(screen) }],
      checks,
      needsLiveScan: checks.some((check) => check.applies && live.has(check.id)),
    };
  });

  // A requirement whose screen no source declares is never scanned, and run() records it as a gap.
  // It does that only when it scans, which is when something is left to check.
  const requirementGaps = plan.nothingToCheck
    ? []
    : await unknownSurfaceGapsForRun(
        requirements,
        coverageFs,
        config,
        (docsManifest?.pages ?? []).map((page) => page.pageId),
      );

  const unresolvedSet = new Set(plan.unresolvedFiles);
  const unresolved = plan.unresolvedFiles.map((file) => ({
    file,
    why: plan.gaps.find((gap) => gap.ref === file)?.reason ?? 'maps to no screen',
  }));
  const gaps = [...plan.gaps.filter((gap) => !unresolvedSet.has(gap.ref)), ...requirementGaps].map((gap) => ({
    ref: gap.ref,
    why: gap.reason,
  }));

  const brief: Brief = {
    version: 1,
    policySource: 'working tree',
    files: changed,
    nothingToCheck: plan.nothingToCheck,
    screens,
    disclosures,
    unresolved,
    gaps,
    done: doneFor(plan.nothingToCheck, screens),
  };
  // Paths, urls, and reasons are operator data, but a configured url can carry a preview token
  // in its query, so every string loses credentials, query strings, and fragments on the way out.
  return scrubOutboundData(brief);
}
