/**
 * Optional Deque axe DevTools provider (axe DevTools for Web Enterprise, Playwright SDK).
 * Registered only when the trusted usabl.config.json turns engines.deque on. The vendor package is
 * loaded by a dynamic import and is never a dependency of usabl.
 *
 * Deque returns standard axe-core results: the open-source axe rules plus Deque's own. usabl's axe
 * provider already reports the open-source rules, so those are dropped here and only Deque's own
 * rules are kept. What is kept maps through the same code as the axe provider, under its own layer
 * and a rule prefix, so a Deque finding never shares an identity, a floor entry, or a waiver with an
 * axe finding.
 *
 * Deque findings are preview in this release: shown, never gating. Its SDK runs its scripts in the
 * page's own world, where page script can reach them, and no live run on a licensed SDK has yet
 * shown which of its rules repeat. Tested against the vendor's documented result format. Not yet
 * run on a licensed SDK. This unit never mints a verdict.
 */
import type {
  Capability,
  CoverageGap,
  DequeEngineConfig,
  EvidenceClass,
  Provider,
  ProviderContext,
  ProviderNote,
  ProviderOutput,
} from '../../contracts/index.js';
import { DOCS_AXE_TAGS, mapAxeRunResult, type AxeRunResult } from '../axe/index.js';
import { normalizeAxeResults } from '../axe/raw.js';
import {
  assertNoOutsideSwitch,
  defaultFileExists,
  EngineTimeoutError,
  errorMessage,
  importPackage,
  loadEngineModule,
  missingExportError,
  notLivePageError,
  openSourceAxeRuleIds,
  pickExport,
  playwrightPageOf,
  probeInstalledPackage,
  withEngineTimeout,
  type EngineLabel,
  type InstalledPackage,
  type ModuleLoader,
} from './shared.js';

export const DEQUE_PACKAGE = '@axe-devtools/playwright';
export const DEQUE_PROVIDER_ID = 'deque';
export const DEQUE_LAYER = 'deque';
// Finding identity leaves the layer out, so the prefix is what keeps a Deque rule from ever sharing
// an identity, a floor entry, or a waiver with an axe rule or a rulepack rule.
export const DEQUE_RULE_PREFIX = 'deque:';
// Deque documents this variable as the switch for its usage service, which is on by default.
export const DEQUE_TRACK_USAGE_ENV = 'AXE_TRACK_USAGE';
// Deque documents these for its CLI: a ruleset file that replaces the whole axe-core ruleset, found
// through this variable or at this name in the working folder. Its Playwright reference does not say
// whether the SDK reads them too, so usabl assumes it may.
export const DEQUE_RULESET_PATH_ENV = 'AXE_RULESET_PATH';
export const DEQUE_RULESET_FILES = ['axe-ruleset.json'] as const;
// The class Deque findings carry until a live run proves which rules are stable.
export const DEQUE_EVIDENCE_CLASS: EvidenceClass = 'preview';

export const DEQUE_LABEL: EngineLabel = {
  vendor: 'Deque axe DevTools',
  packageName: DEQUE_PACKAGE,
  configKey: 'engines.deque',
  registry: "Deque's registry (axe DevTools for Web Enterprise)",
};

type EnvReader = Readonly<Record<string, string | undefined>>;

export interface DequeProviderOptions {
  // Default: a dynamic import of DEQUE_PACKAGE.
  load?: ModuleLoader;
  // Where AXE_TRACK_USAGE and AXE_RULESET_PATH are read. Read only, never written. buildDeps passes
  // the environment it reads the session from. Default: process.env.
  env?: EnvReader;
  // The folder a ruleset file would be read from. Default: process.cwd().
  cwd?: string;
  // Default: the rule list of the installed axe-core.
  axeRuleIds?: () => Promise<ReadonlySet<string>>;
  // Default: a read of the node_modules folders the dynamic import searches. Only consulted to
  // explain a failed import.
  probe?: (packageName: string) => Promise<InstalledPackage>;
  // Default: a stat of the path.
  fileExists?: (path: string) => Promise<boolean>;
  // Budget for each vendor call. Default: ENGINE_CALL_TIMEOUT_MS.
  timeoutMs?: number;
}

export function dequeCapabilities(config: DequeEngineConfig): Capability[] {
  return config.trackUsage === true ? ['live', 'network'] : ['live'];
}

const BUCKETS = ['violations', 'incomplete', 'passes', 'inapplicable'] as const;
type Bucket = (typeof BUCKETS)[number];

// Every bucket must be a list. A result missing one is not an axe result, and reading it as empty
// buckets would report a clean page nobody checked.
function isAxeResultsShape(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') {
    return false;
  }
  return BUCKETS.every((bucket) => Array.isArray(Reflect.get(raw, bucket)));
}

/** Keeps only the rules open-source axe-core does not have. Pure. */
export function withoutOpenSourceAxeRules(
  result: Pick<AxeRunResult, Bucket>,
  axeRuleIds: ReadonlySet<string>,
): Pick<AxeRunResult, Bucket> {
  const keep = (entry: { id: string }): boolean => !axeRuleIds.has(entry.id);
  return {
    violations: result.violations.filter(keep),
    incomplete: result.incomplete.filter(keep),
    passes: result.passes.filter(keep),
    inapplicable: result.inapplicable.filter(keep),
  };
}

function rawBucket(raw: unknown, bucket: Bucket): unknown[] {
  const entries: unknown = raw !== null && typeof raw === 'object' ? Reflect.get(raw, bucket) : undefined;
  return Array.isArray(entries) ? entries : [];
}

function rawId(entry: unknown): string | null {
  const id: unknown = entry !== null && typeof entry === 'object' ? Reflect.get(entry, 'id') : undefined;
  return typeof id === 'string' ? id : null;
}

function dequeGap(reason: string): CoverageGap {
  return { ref: `provider:${DEQUE_PROVIDER_ID}`, state: 'not-covered', reason };
}

/**
 * Maps raw Deque results for one screen to drafts, applicability, gaps, and notes. Pure.
 *
 * The axe normalizer skips an entry it cannot read. For Deque's own rules that would hide a finding
 * no other provider reports, so every own entry the normalizer lost is disclosed, and so is a
 * violation whose element list is not a list. While Deque findings are preview a lost one could
 * never have moved the verdict, so the disclosure is a note. If they ever gate, the same loss is a
 * coverage gap. A result with no rule in any bucket checked nothing, which is always a gap.
 */
export function mapDequeResults(
  raw: unknown,
  screenId: string,
  axeRuleIds: ReadonlySet<string>,
  evidenceClass: EvidenceClass = DEQUE_EVIDENCE_CLASS,
): ProviderOutput & { gaps: CoverageGap[]; notes: ProviderNote[] } {
  if (BUCKETS.every((bucket) => rawBucket(raw, bucket).length === 0)) {
    return {
      drafts: [],
      applicability: [],
      gaps: [
        dequeGap(
          'Deque ran no rules on this screen, so it checked nothing. Check engines.deque.rulesetId, or set engines.deque.enabled to false.',
        ),
      ],
      notes: [],
    };
  }

  const ownRules = withoutOpenSourceAxeRules(normalizeAxeResults(raw), axeRuleIds);
  const lost: string[] = [];
  for (const bucket of BUCKETS) {
    const kept = new Map<string, number>();
    for (const entry of ownRules[bucket]) {
      kept.set(entry.id, (kept.get(entry.id) ?? 0) + 1);
    }
    for (const entry of rawBucket(raw, bucket)) {
      const id = rawId(entry);
      if (id !== null && axeRuleIds.has(id)) {
        continue;
      }
      const left = id === null ? 0 : (kept.get(id) ?? 0);
      if (id === null || left === 0) {
        lost.push(
          `Deque's ${bucket} result for ${id ?? 'unknown rule'} could not be read, so usabl could not show it or check it against the gate.`,
        );
        continue;
      }
      kept.set(id, left - 1);
      const nodes: unknown = Reflect.get(entry as object, 'nodes');
      if (bucket === 'violations' && !Array.isArray(nodes)) {
        lost.push(
          `Deque's violations result for ${id} has an element list that could not be read, so usabl could not show its elements or check them against the gate.`,
        );
      }
    }
  }

  const mapped = mapAxeRunResult(ownRules, screenId, {
    layer: DEQUE_LAYER,
    rulePrefix: DEQUE_RULE_PREFIX,
    evidenceClass,
  });
  const ref = `provider:${DEQUE_PROVIDER_ID}`;
  return evidenceClass === 'deterministic'
    ? { ...mapped, gaps: lost.map((reason) => dequeGap(reason)), notes: [] }
    : { ...mapped, gaps: [], notes: lost.map((reason) => ({ ref, reason })) };
}

interface DequeBuilder {
  analyze(): Promise<unknown>;
  enableTracking?: (state: boolean) => unknown;
  withTags?: (tags: string[]) => DequeBuilder;
}
type DequeBuilderClass = new (options: { page: unknown; rulesetId?: string }) => DequeBuilder;

const defaultLoad: ModuleLoader = () => importPackage(DEQUE_PACKAGE);

export function makeDequeProvider(config: DequeEngineConfig, options: DequeProviderOptions = {}): Provider {
  const load = options.load ?? defaultLoad;
  const env = options.env ?? process.env;
  const probe = options.probe ?? ((name: string) => probeInstalledPackage(name));
  const fileExists = options.fileExists ?? defaultFileExists;
  const readAxeRuleIds = options.axeRuleIds ?? openSourceAxeRuleIds;
  const trackingOff = config.trackUsage !== true;
  let axeRuleIds: Promise<ReadonlySet<string>> | null = null;

  return {
    id: DEQUE_PROVIDER_ID,
    layer: DEQUE_LAYER,
    capabilities: dequeCapabilities(config),
    async run(ctx: ProviderContext): Promise<ProviderOutput> {
      const pw = playwrightPageOf(ctx.page);
      if (pw === null) {
        throw notLivePageError(DEQUE_LABEL);
      }

      // Checked before the package loads, so nothing from Deque runs while a switch outside the
      // trusted config could turn its usage service on or replace its rules with an empty set.
      await assertNoOutsideSwitch(DEQUE_LABEL, {
        env,
        variables: [
          ...(trackingOff
            ? [{ name: DEQUE_TRACK_USAGE_ENV, safe: 'false', why: 'can turn on Deque usage reporting, which usabl keeps off' }]
            : []),
          {
            name: DEQUE_RULESET_PATH_ENV,
            safe: null,
            why: 'can replace every Deque rule with a ruleset outside the trusted config, so it could report nothing',
          },
        ],
        files: DEQUE_RULESET_FILES,
        why: 'can replace every Deque rule with a ruleset outside the trusted config, so it could report nothing',
        guardedPaths: ctx.config.guardedPaths,
        cwd: options.cwd ?? process.cwd(),
        fileExists,
      });

      const module = await loadEngineModule(DEQUE_LABEL, {
        load,
        probe,
        redact: (text) => text,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      const Builder = pickExport(module, 'AxeDevToolsBuilder');
      if (typeof Builder !== 'function') {
        throw missingExportError(DEQUE_LABEL, 'AxeDevToolsBuilder');
      }

      axeRuleIds ??= readAxeRuleIds();
      const knownAxeRules = await axeRuleIds;

      let builder: DequeBuilder;
      try {
        builder = new (Builder as DequeBuilderClass)({
          page: pw,
          ...(config.rulesetId === undefined ? {} : { rulesetId: config.rulesetId }),
        });
      } catch (error) {
        throw new Error(`${DEQUE_LABEL.vendor} analysis failed: ${errorMessage(error)}`);
      }
      if (trackingOff && typeof builder.enableTracking !== 'function' && env[DEQUE_TRACK_USAGE_ENV] !== 'false') {
        throw new Error(
          `This version of ${DEQUE_PACKAGE} has no enableTracking, so usabl cannot turn its usage reporting off. To fix it, set ${DEQUE_TRACK_USAGE_ENV} to false, or set engines.deque.enabled to false.`,
        );
      }
      const docs = (ctx.profile ?? 'app') === 'docs';
      if (docs && typeof builder.withTags !== 'function') {
        // Docs screens are held to the WCAG 2.2 AA tag set, as axe is. Running Deque's whole ruleset
        // there would show findings against criteria the docs surface does not claim.
        throw new Error(
          `This version of ${DEQUE_PACKAGE} has no withTags, so usabl cannot limit it to the docs WCAG tags on a docs screen. Set engines.deque.enabled to false to scan docs without it.`,
        );
      }

      let raw: unknown;
      try {
        if (trackingOff && typeof builder.enableTracking === 'function') {
          builder.enableTracking(false);
        }
        if (docs && typeof builder.withTags === 'function') {
          // The same tag set the axe provider passes on a docs screen. The builder is chainable in
          // Deque's reference; a return without analyze() means the call changed the builder in place.
          const tagged: unknown = builder.withTags([...DOCS_AXE_TAGS]);
          if (tagged !== null && typeof tagged === 'object' && typeof Reflect.get(tagged, 'analyze') === 'function') {
            builder = tagged as DequeBuilder;
          }
        }
        raw = await withEngineTimeout(DEQUE_LABEL, 'analysis', builder.analyze(), options.timeoutMs);
      } catch (error) {
        if (error instanceof EngineTimeoutError) {
          throw error;
        }
        throw new Error(`${DEQUE_LABEL.vendor} analysis failed: ${errorMessage(error)}`);
      }
      if (!isAxeResultsShape(raw)) {
        throw new Error(
          `${DEQUE_LABEL.vendor} returned something that is not an axe results object, so usabl cannot say what it checked.`,
        );
      }
      return mapDequeResults(raw, ctx.screen.id, knownAxeRules);
    },
  };
}
