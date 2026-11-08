/**
 * Optional Evinced provider (Evinced Automation for Web, Playwright SDK).
 * Registered only when the trusted usabl.config.json turns engines.evinced on. The vendor package is
 * loaded by a dynamic import and is never a dependency of usabl.
 *
 * Evinced findings are preview in this release: shown, never gating. Evinced uses machine learning,
 * its SDK runs its scripts in the page's own world, and no live run on a licensed SDK has yet shown
 * which issue types repeat. Tested against the vendor's documented result format. Not yet run on a
 * licensed SDK. The mapping can promote a type, so the disclosures that guard a promoted type are in
 * place for when a live run names the stable types, but the config cannot ask for one. While no type
 * gates, an Evinced that could not run is a provider note, never a gap. Evinced
 * reports no passes, so it adds findings and never claims coverage: it records no applicability.
 *
 * The SDK holds credentials. Every message and every string it returns passes through a redactor
 * seeded with the credential values, so a vendor error that quotes a token cannot carry it out.
 * This unit never mints a verdict.
 */
import type {
  Capability,
  CoverageGap,
  Draft,
  EvidenceClass,
  EvincedEngineConfig,
  EvincedMode,
  Provider,
  ProviderContext,
  ProviderNote,
  ProviderOutput,
  Severity,
} from '../../contracts/index.js';
import {
  assertNoOutsideSwitch,
  couldNotRunOutput,
  defaultFileExists,
  EngineTimeoutError,
  errorMessage,
  importPackage,
  loadEngineModule,
  makeRedactor,
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
import { ENGINE_PREVIEW } from '../applicability.js';

export const EVINCED_PACKAGE = '@evinced/js-playwright-sdk';
export const EVINCED_PROVIDER_ID = 'evinced';
export const EVINCED_LAYER = 'evinced';
export const EVINCED_RULE_PREFIX = 'evinced:';
export const EVINCED_SERVICE_ID_ENV = 'EVINCED_SERVICE_ID';
export const EVINCED_AUTH_TOKEN_ENV = 'EVINCED_AUTH_TOKEN';
export const EVINCED_API_KEY_ENV = 'EVINCED_API_KEY';
export const EVINCED_SWITCH_ENV = 'EV_SWITCH_ON';
export const EVINCED_CONFIG_FILES = ['evConfig.json', 'evConfig.yaml', 'evConfig.yml'] as const;

export const EVINCED_LABEL: EngineLabel = {
  vendor: 'Evinced',
  packageName: EVINCED_PACKAGE,
  configKey: 'engines.evinced',
  registry: "Evinced's registry (Automation for Web license)",
};

type EnvReader = Readonly<Record<string, string | undefined>>;

export interface EvincedProviderOptions {
  // Default: a dynamic import of EVINCED_PACKAGE.
  load?: ModuleLoader;
  // Where credentials and EV_SWITCH_ON are read. Read only, never written. buildDeps passes the
  // environment it reads the session from. Default: process.env.
  env?: EnvReader;
  // The folder an evConfig file would be read from. Default: process.cwd().
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
  // Evinced issue type ids whose findings gate. Default: none, so every finding is preview. The
  // config cannot set it; it is the switch a later promotion flips. While no type gates, an Evinced
  // that could not run is a note; once one does, the same failure is a coverage gap, because it
  // could hide a gating finding.
  promote?: ReadonlySet<string>;
}

export function evincedMode(config: EvincedEngineConfig): EvincedMode {
  return config.mode ?? 'offline';
}

// Offline mode needs no license server. Online mode contacts Evinced's, so it needs the network.
export function evincedCapabilities(config: EvincedEngineConfig): Capability[] {
  return evincedMode(config) === 'online' ? ['live', 'secrets', 'network'] : ['live', 'secrets'];
}

/** The environment variable names each mode reads. Names only; values are never returned. */
export function evincedCredentialNames(mode: EvincedMode): [string, string] {
  return mode === 'online'
    ? [EVINCED_SERVICE_ID_ENV, EVINCED_API_KEY_ENV]
    : [EVINCED_SERVICE_ID_ENV, EVINCED_AUTH_TOKEN_ENV];
}

function readEnv(env: EnvReader, name: string): string | null {
  const value = env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Which of the mode's credential variables are unset or empty. Names only. */
export function missingEvincedCredentials(env: EnvReader, mode: EvincedMode): string[] {
  return evincedCredentialNames(mode).filter((name) => readEnv(env, name) === null);
}

function getProp(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

const KNOWN_SEVERITIES: Record<string, Severity> = {
  critical: 'critical',
  serious: 'serious',
  moderate: 'moderate',
  minor: 'minor',
};

/**
 * Evinced's four impact levels map to usabl's. Any other level, such as "Needs Review" or "Best
 * Practice", still surfaces, but as preview evidence whatever the promote list says: Evinced itself
 * has not called it a failure at a known impact. The severity may be a plain string or an object
 * with a name or an id.
 */
function readSeverity(rawSeverity: unknown): { severity: Severity; known: boolean; label: string | null } {
  const label =
    readString(rawSeverity) ?? readString(getProp(rawSeverity, 'name')) ?? readString(getProp(rawSeverity, 'id'));
  const known = label === null ? undefined : KNOWN_SEVERITIES[label.trim().toLowerCase()];
  return known === undefined ? { severity: 'moderate', known: false, label } : { severity: known, known: true, label };
}

const EVINCED_REF = `provider:${EVINCED_PROVIDER_ID}`;

function evincedGap(reason: string): CoverageGap {
  return { ref: EVINCED_REF, state: 'not-covered', reason };
}

/**
 * Maps the issue list Evinced returned to drafts, one per element. Pure.
 *
 * The issue shape is only partly documented, so every field is read as the untyped value it is. An
 * issue without a type id has no identity, and an element without a selector cannot be located, so
 * neither is shown. For a preview type that changes no verdict, and one note counts what was not
 * shown. Only for a promoted type could it, so only there is every element that could not be read,
 * and every issue whose severity could not be read, a coverage gap. promote is empty unless a caller
 * passes one; the provider passes none in this release.
 */
export function mapEvincedIssues(
  issues: readonly unknown[],
  screenId: string,
  promote: ReadonlySet<string> = new Set(),
  redact: (text: string) => string = (text) => text,
): { drafts: Draft[]; gaps: CoverageGap[]; notes: ProviderNote[] } {
  const drafts: Draft[] = [];
  let unreadablePromoted = 0;
  let unreadableSeverityPromoted = 0;
  let untypedIssues = 0;
  let unreadablePreview = 0;

  for (const issue of issues) {
    const typeId = readString(getProp(getProp(issue, 'type'), 'id'));
    if (typeId === null) {
      untypedIssues += 1;
      continue;
    }
    const typeName = readString(getProp(getProp(issue, 'type'), 'name')) ?? typeId;
    const { severity, known, label } = readSeverity(getProp(issue, 'severity'));
    const promoted = promote.has(typeId);
    const evidenceClass: EvidenceClass = known && promoted ? 'deterministic' : 'preview';
    if (label === null && promoted) {
      unreadableSeverityPromoted += 1;
    }
    const summary = readString(getProp(issue, 'summary'));
    const description = readString(getProp(issue, 'description'));
    const link = readString(getProp(issue, 'knowledgeBaseLink'));

    const rawElements = getProp(issue, 'elements');
    const selectors = (Array.isArray(rawElements) ? rawElements : [])
      .map((element) => readString(getProp(element, 'selector')))
      .filter((selector): selector is string => selector !== null);
    // An element list that is missing or empty leaves the whole issue unreadable, so it counts as
    // one. Otherwise every element without a selector counts.
    const rawCount = Array.isArray(rawElements) ? rawElements.length : 0;
    const unreadable = rawCount === 0 ? 1 : rawCount - selectors.length;
    if (evidenceClass === 'deterministic') {
      unreadablePromoted += unreadable;
    } else {
      unreadablePreview += unreadable;
    }

    const whatUserExperiences = summary ?? typeName;
    const why = description ?? `Evinced reports this element as ${typeName}.`;
    const fix =
      link === null
        ? `Evinced gave no fix text for this issue. Look up ${typeName} in Evinced's knowledge base.`
        : `Follow Evinced's guidance for ${typeName}: ${link}`;

    for (const selector of selectors) {
      drafts.push({
        rule: `${EVINCED_RULE_PREFIX}${redact(typeId)}`,
        layer: EVINCED_LAYER,
        severity,
        evidenceClass,
        screenId,
        elementPath: redact(selector),
        elementName: null,
        role: null,
        whatUserExperiences: redact(whatUserExperiences),
        why: redact(why),
        fix: redact(fix),
        evidence: { extra: { evincedSeverity: label === null ? null : redact(label) } },
        confidence: 'fail',
      });
    }
  }

  const gaps: CoverageGap[] = [];
  if (unreadablePromoted > 0) {
    gaps.push(
      evincedGap(
        `${unreadablePromoted} promoted Evinced element(s) could not be read: Evinced gave no element selector usabl could use, so they could not be checked against the gate.`,
      ),
    );
  }
  if (unreadableSeverityPromoted > 0) {
    gaps.push(
      evincedGap(
        `${unreadableSeverityPromoted} promoted Evinced issue(s) with an unreadable severity were shown but could not block, because usabl cannot tell what impact Evinced gave them.`,
      ),
    );
  }
  const notes: ProviderNote[] = [];
  if (untypedIssues > 0 || unreadablePreview > 0) {
    const parts = [
      ...(untypedIssues > 0 ? [`${untypedIssues} issue(s) with no type usabl could read`] : []),
      ...(unreadablePreview > 0 ? [`${unreadablePreview} element(s) with no selector usabl could use`] : []),
    ];
    notes.push({
      ref: EVINCED_REF,
      reason: `Evinced reported ${parts.join(' and ')}, so they are not shown. Its findings are preview, so this does not change the verdict.`,
    });
  }
  return { drafts, gaps, notes };
}

const defaultLoad: ModuleLoader = () => importPackage(EVINCED_PACKAGE);

type Callable = (...args: unknown[]) => unknown;
interface EvincedSdk {
  evAnalyze(options: unknown): Promise<unknown>;
}
type EvincedSdkClass = new (page: unknown) => EvincedSdk;

/**
 * Turns off, inside Evinced, every rule open-source axe-core has. usabl's axe provider already
 * reports those, so leaving them on would report one barrier twice. switchOn is passed as well, so a
 * global switch usabl did not see is overridden where the SDK honors it.
 */
export function evincedAnalyzeOptions(axeRuleIds: ReadonlySet<string>): unknown {
  const rules: Record<string, { enabled: false }> = {};
  for (const id of [...axeRuleIds].sort()) {
    rules[id] = { enabled: false };
  }
  return { switchOn: true, analysis: { AXE_CONFIG: { rules } } };
}

export function makeEvincedProvider(config: EvincedEngineConfig, options: EvincedProviderOptions = {}): Provider {
  const load = options.load ?? defaultLoad;
  const env = options.env ?? process.env;
  const probe = options.probe ?? ((name: string) => probeInstalledPackage(name));
  const fileExists = options.fileExists ?? defaultFileExists;
  const readAxeRuleIds = options.axeRuleIds ?? openSourceAxeRuleIds;
  const mode = evincedMode(config);
  const promote = options.promote ?? new Set<string>();
  let axeRuleIds: Promise<ReadonlySet<string>> | null = null;
  const timed = <T>(step: string, call: Promise<T>): Promise<T> =>
    withEngineTimeout(EVINCED_LABEL, step, call, options.timeoutMs);

  async function analyze(ctx: ProviderContext, redact: (text: string) => string): Promise<ProviderOutput> {
    const pw = playwrightPageOf(ctx.page);
    if (pw === null) {
      throw notLivePageError(EVINCED_LABEL);
    }

    // Evinced reads a global switch from the environment and from evConfig files. An empty report
    // from a switched-off SDK would look like a clean screen, so usabl refuses to run while the
    // switch could be off.
    await assertNoOutsideSwitch(EVINCED_LABEL, {
      env,
      variables: [{ name: EVINCED_SWITCH_ENV, safe: 'true', why: 'can turn Evinced off so it reports nothing' }],
      files: EVINCED_CONFIG_FILES,
      why: 'can turn Evinced off so it reports nothing',
      guardedPaths: ctx.config.guardedPaths,
      cwd: options.cwd ?? process.cwd(),
      fileExists,
    });

    const module = await loadEngineModule(EVINCED_LABEL, {
      load,
      probe,
      redact,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });

    const missing = missingEvincedCredentials(env, mode);
    if (missing.length > 0) {
      const needed = evincedCredentialNames(mode).join(' and ');
      throw new Error(
        `Evinced is turned on in usabl.config.json in ${mode} mode, but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set. Set ${needed}, or set engines.evinced.enabled to false.`,
      );
    }
    const [serviceIdName, secretName] = evincedCredentialNames(mode);
    const serviceId = readEnv(env, serviceIdName) ?? '';
    const secret = readEnv(env, secretName) ?? '';

    const EvincedSDK = pickExport(module, 'EvincedSDK');
    if (typeof EvincedSDK !== 'function') {
      throw missingExportError(EVINCED_LABEL, 'EvincedSDK');
    }
    const credentialExport = mode === 'online' ? 'setCredentials' : 'setOfflineCredentials';
    const setCredentials = pickExport(module, credentialExport);
    if (typeof setCredentials !== 'function') {
      throw missingExportError(EVINCED_LABEL, credentialExport);
    }

    axeRuleIds ??= readAxeRuleIds();
    const knownAxeRules = await axeRuleIds;

    let issues: unknown;
    try {
      // Platform upload sends results to Evinced's service. usabl keeps results on this machine.
      const setUpload = pickExport(module, 'setUploadToPlatformConfig');
      if (typeof setUpload === 'function') {
        await timed('turning off platform upload', Promise.resolve((setUpload as Callable)({ enableUploadToPlatform: false })));
      }
      // Online mode checks the credentials with Evinced's license server here, which is the call a
      // hung server leaves waiting.
      await timed(
        'setting its credentials',
        Promise.resolve((setCredentials as Callable)(mode === 'online' ? { serviceId, secret } : { serviceId, token: secret })),
      );
      const sdk = new (EvincedSDK as EvincedSdkClass)(pw);
      issues = await timed('analysis', sdk.evAnalyze(evincedAnalyzeOptions(knownAxeRules)));
    } catch (error) {
      if (error instanceof EngineTimeoutError) {
        throw error;
      }
      throw new Error(`Evinced analysis failed: ${errorMessage(error)}`);
    }
    if (!Array.isArray(issues)) {
      throw new Error('Evinced returned something that is not a list of issues, so usabl cannot say what it found.');
    }

    // No applicability: Evinced reports no passes, so it can add findings but never claims a rule
    // ran clean on this screen. The promote list is empty in this release, so every finding is preview.
    return mapEvincedIssues(issues, ctx.screen.id, promote, redact);
  }

  return {
    id: EVINCED_PROVIDER_ID,
    layer: EVINCED_LAYER,
    capabilities: evincedCapabilities(config),
    appliesBeforeScan: () => ({ applies: true, why: ENGINE_PREVIEW }),
    async run(ctx: ProviderContext): Promise<ProviderOutput> {
      // Seeded with every Evinced credential in the environment, whichever mode is on, before
      // anything can fail, so no path out of this provider carries a credential value. Each value
      // is seeded as set and trimmed: a value set with padding is handed to the SDK as set, and an
      // SDK that trims it would quote the trimmed form back.
      const redact = makeRedactor(
        [EVINCED_SERVICE_ID_ENV, EVINCED_AUTH_TOKEN_ENV, EVINCED_API_KEY_ENV]
          .map((name) => readEnv(env, name))
          .filter((value): value is string => value !== null)
          .flatMap((value) => [value, value.trim()]),
      );
      try {
        return await analyze(ctx, redact);
      } catch (error) {
        const message = redact(errorMessage(error));
        if (promote.size > 0) {
          throw new Error(message);
        }
        return couldNotRunOutput(EVINCED_PROVIDER_ID, message);
      }
    },
  };
}
