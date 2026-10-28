/**
 * Reads a Result that was composed outside this process and checks it against the Result
 * contract in src/contracts, field by field.
 *
 * `usabl comment` and `usabl enforce` read a Result from standard input. Whoever wrote that
 * document chose every value in it, so nothing in it is trusted until it has the shape the
 * contract states: every list is a list, every count is a whole number, every enum value is one of
 * its values, and every nested object has the fields it claims. A document that supplied text
 * where a count belongs used to reach the comment as that text.
 *
 * The value returned is built from the checked fields only. A field the contract does not name is
 * dropped, so no projector downstream can read it. Record keys are copied as data, so a key named
 * `__proto__` stays an own key and never changes a prototype.
 *
 * A refusal is an InputRefusedError that names the field by its path and never repeats the value
 * found there, because the value may be text written to render as a link or a mention. A record
 * key is page text too, so a bad record entry is named by its position, not its key.
 *
 * The draft and coverage readers are also exported for the gate, which checks the drafts and the
 * coverage a library caller hands it against the same contract, with its own wording.
 *
 * This unit checks shape only. It must never decide a verdict, and it does not judge whether the
 * values agree with each other: the receipt, not the document, is what proves a run happened.
 */
import type {
  AffectedScreen,
  AnnouncementToken,
  AppSourceMapping,
  Coverage,
  CoverageGap,
  DocsSourceMapping,
  Draft,
  EvidenceFacts,
  Fact,
  Finding,
  FloorHeadroom,
  FloorUnconfirmed,
  Receipt,
  Result,
  RuleApplicability,
  ScreenScan,
  TranscriptStop,
} from '../contracts/index.js';
import { InputRefusedError } from './input-refusal.js';

type Json = Record<string, unknown>;

const FIX = 'Pass the Result JSON that "usabl check --json" wrote, unchanged.';

/**
 * One field that does not match the contract. Readers throw it, and each public entry point turns
 * it into an InputRefusedError worded for its own caller. The problem text never holds the value.
 */
class ShapeProblem extends Error {
  readonly field: string;
  readonly problem: string;

  constructor(field: string, problem: string) {
    super(problem);
    this.field = field;
    this.problem = problem;
  }
}

function refuse(field: string, problem: string): never {
  throw new ShapeProblem(field, problem);
}

/** Runs a reader and words any problem it finds for the caller. */
function worded<T>(read: () => T, word: (field: string, problem: string) => string): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof ShapeProblem) {
      throw new InputRefusedError(err.field, word(err.field, err.problem));
    }
    throw err;
  }
}

const resultWording = (field: string, problem: string): string =>
  `${field.length === 0 ? 'The Result' : `The Result field ${field}`} ${problem}. ${FIX}`;

/**
 * Reads one Draft against the contract and returns a copy built from the checked fields. Each
 * field is read once. `source` names the caller in the refusal, for example "gate() input".
 */
export function readDraftShape(value: unknown, field: string, source: string): Draft {
  return worded(() => draft(value, field), (at, problem) => `${source} ${at} ${problem}.`);
}

/**
 * Reads one Coverage against the contract and returns a copy built from the checked fields, with
 * the same wording as readDraftShape. It checks shape only, not the id grammar.
 */
export function readCoverageShape(value: unknown, field: string, source: string): Coverage {
  return worded(() => coverage(value, field), (at, problem) => `${source} ${at} ${problem}.`);
}

function at(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Json {
  if (!isRecord(value)) refuse(field, 'must be an object');
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') refuse(field, 'must be a string');
  return value;
}

function textOrNull(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') refuse(field, 'must be a string or null');
  return value;
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') refuse(field, 'must be true or false');
  return value;
}

function flagOrNull(value: unknown, field: string): boolean | null {
  if (value !== null && typeof value !== 'boolean') refuse(field, 'must be true, false, or null');
  return value;
}

function whole(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    refuse(field, 'must be a whole number, zero or more');
  }
  return value;
}

function wholeOrNull(value: unknown, field: string): number | null {
  return value === null ? null : whole(value, field);
}

function oneOf<T extends string | number>(value: unknown, field: string, allowed: readonly T[]): T {
  if (!(allowed as readonly unknown[]).includes(value)) {
    refuse(field, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function oneOfOrNull<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | null {
  if (value === null) return null;
  if (!(allowed as readonly unknown[]).includes(value)) {
    refuse(field, `must be null or one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function list<T>(value: unknown, field: string, item: (value: unknown, field: string) => T): T[] {
  if (!Array.isArray(value)) refuse(field, 'must be a list');
  return value.map((entry, index) => item(entry, `${field}[${index}]`));
}

const texts = (value: unknown, field: string): string[] => list(value, field, text);

/** A key that is absent reads as undefined. JSON has no undefined, so absent is the only way. */
function has(source: Json, key: string): boolean {
  return Object.hasOwn(source, key) && source[key] !== undefined;
}

const FACT_SOURCES = ['ax-tree', 'attribute'] as const;

function fact(value: unknown, field: string): Fact {
  const source = record(value, field);
  return {
    value: textOrNull(source['value'], at(field, 'value')),
    source: oneOf(source['source'], at(field, 'source'), FACT_SOURCES),
    fromTree: flag(source['fromTree'], at(field, 'fromTree')),
  };
}

function anyFact(value: unknown, field: string): Fact<unknown> {
  const source = record(value, field);
  if (!Object.hasOwn(source, 'value')) refuse(at(field, 'value'), 'is missing');
  return {
    value: source['value'],
    source: oneOf(source['source'], at(field, 'source'), FACT_SOURCES),
    fromTree: flag(source['fromTree'], at(field, 'fromTree')),
  };
}

function evidence(value: unknown, field: string): EvidenceFacts {
  const source = record(value, field);
  const out: EvidenceFacts = {};
  if (has(source, 'name')) out.name = fact(source['name'], at(field, 'name'));
  if (has(source, 'role')) out.role = fact(source['role'], at(field, 'role'));
  if (has(source, 'state')) {
    const stateField = at(field, 'state');
    const state = record(source['state'], stateField);
    // Named by position, never by key: a state key comes from the page.
    out.state = Object.fromEntries(
      Object.entries(state).map(([key, entry], index) => [key, anyFact(entry, `${stateField} entry ${index + 1}`)]),
    );
  }
  if (has(source, 'extra')) {
    out.extra = Object.fromEntries(Object.entries(record(source['extra'], at(field, 'extra'))));
  }
  return out;
}

const SEVERITIES = ['critical', 'serious', 'moderate', 'minor'] as const;
const EVIDENCE_CLASSES = ['deterministic', 'preview', 'model-judgment', 'human-confirmed'] as const;
const CONFIDENCES = ['fail', 'unverified'] as const;

function draft(value: unknown, field: string): Draft {
  const source = record(value, field);
  return {
    rule: text(source['rule'], at(field, 'rule')),
    layer: text(source['layer'], at(field, 'layer')),
    severity: oneOf(source['severity'], at(field, 'severity'), SEVERITIES),
    evidenceClass: oneOf(source['evidenceClass'], at(field, 'evidenceClass'), EVIDENCE_CLASSES),
    screenId: text(source['screenId'], at(field, 'screenId')),
    elementPath: text(source['elementPath'], at(field, 'elementPath')),
    elementName: textOrNull(source['elementName'], at(field, 'elementName')),
    role: textOrNull(source['role'], at(field, 'role')),
    whatUserExperiences: text(source['whatUserExperiences'], at(field, 'whatUserExperiences')),
    why: text(source['why'], at(field, 'why')),
    fix: text(source['fix'], at(field, 'fix')),
    evidence: evidence(source['evidence'], at(field, 'evidence')),
    confidence: oneOf(source['confidence'], at(field, 'confidence'), CONFIDENCES),
  };
}

function docsSource(value: unknown, field: string): DocsSourceMapping {
  const source = record(value, field);
  return {
    tier: oneOf(source['tier'], at(field, 'tier'), ['renderer', 'content', 'fallback'] as const),
    file: textOrNull(source['file'], at(field, 'file')),
    candidates: texts(source['candidates'], at(field, 'candidates')),
    construct: textOrNull(source['construct'], at(field, 'construct')),
    line: wholeOrNull(source['line'], at(field, 'line')),
    fix: text(source['fix'], at(field, 'fix')),
  };
}

function appSource(value: unknown, field: string): AppSourceMapping {
  const source = record(value, field);
  return {
    tier: oneOf(source['tier'], at(field, 'tier'), ['renderer', 'import-chain', 'coverage'] as const),
    file: textOrNull(source['file'], at(field, 'file')),
    line: wholeOrNull(source['line'], at(field, 'line')),
    candidates: texts(source['candidates'], at(field, 'candidates')),
  };
}

function finding(value: unknown, field: string): Finding {
  const source = record(value, field);
  const out: Finding = {
    ...draft(source, field),
    elementKey: textOrNull(source['elementKey'], at(field, 'elementKey')),
    identityBasis: oneOf(source['identityBasis'], at(field, 'identityBasis'), ['name', 'structural', 'count'] as const),
    status: oneOf(source['status'], at(field, 'status'), ['new', 'carried', 'fixed', 'waived'] as const),
  };
  if (has(source, 'docsSource')) out.docsSource = docsSource(source['docsSource'], at(field, 'docsSource'));
  if (has(source, 'appSource')) out.appSource = appSource(source['appSource'], at(field, 'appSource'));
  return out;
}

function gap(value: unknown, field: string): CoverageGap {
  const source = record(value, field);
  return {
    ref: text(source['ref'], at(field, 'ref')),
    state: oneOf(source['state'], at(field, 'state'), ['unresolved', 'not-covered', 'skipped', 'capability-denied'] as const),
    reason: text(source['reason'], at(field, 'reason')),
  };
}

function token(value: unknown, field: string): AnnouncementToken {
  const source = record(value, field);
  return {
    kind: oneOf(source['kind'], at(field, 'kind'), ['name', 'role', 'state', 'live'] as const),
    text: textOrNull(source['text'], at(field, 'text')),
    fromTree: flag(source['fromTree'], at(field, 'fromTree')),
    source: oneOf(source['source'], at(field, 'source'), FACT_SOURCES),
  };
}

function stop(value: unknown, field: string): TranscriptStop {
  const source = record(value, field);
  return {
    index: whole(source['index'], at(field, 'index')),
    elementPath: text(source['elementPath'], at(field, 'elementPath')),
    announcement: list(source['announcement'], at(field, 'announcement'), token),
  };
}

function ruleApplicability(value: unknown, field: string): RuleApplicability {
  const source = record(value, field);
  return {
    screenId: text(source['screenId'], at(field, 'screenId')),
    layer: text(source['layer'], at(field, 'layer')),
    rule: text(source['rule'], at(field, 'rule')),
    outcome: oneOf(source['outcome'], at(field, 'outcome'), ['failed', 'incomplete', 'passed', 'inapplicable'] as const),
    elementCount: whole(source['elementCount'], at(field, 'elementCount')),
  };
}

function screen(value: unknown, field: string): ScreenScan {
  const source = record(value, field);
  const out: ScreenScan = {
    screenId: text(source['screenId'], at(field, 'screenId')),
    url: text(source['url'], at(field, 'url')),
    stops: list(source['stops'], at(field, 'stops'), stop),
    drafts: list(source['drafts'], at(field, 'drafts'), draft),
    gaps: list(source['gaps'], at(field, 'gaps'), gap),
    applicability: list(source['applicability'], at(field, 'applicability'), ruleApplicability),
    reachedSelectorPresent: flagOrNull(source['reachedSelectorPresent'], at(field, 'reachedSelectorPresent')),
  };
  if (has(source, 'reachedWhenSelector')) {
    out.reachedWhenSelector = textOrNull(source['reachedWhenSelector'], at(field, 'reachedWhenSelector'));
  }
  if (has(source, 'reachedResponseSeen')) {
    out.reachedResponseSeen = flagOrNull(source['reachedResponseSeen'], at(field, 'reachedResponseSeen'));
  }
  if (has(source, 'reachedWhenResponse')) {
    out.reachedWhenResponse = textOrNull(source['reachedWhenResponse'], at(field, 'reachedWhenResponse'));
  }
  if (has(source, 'browserSandbox')) {
    out.browserSandbox = oneOf(source['browserSandbox'], at(field, 'browserSandbox'), ['off'] as const);
  }
  return out;
}

function affectedScreen(value: unknown, field: string): AffectedScreen {
  const source = record(value, field);
  const out: AffectedScreen = {
    screenId: text(source['screenId'], at(field, 'screenId')),
    url: text(source['url'], at(field, 'url')),
    provenance: oneOf(source['provenance'], at(field, 'provenance'), ['route-graph', 'wide-blast', 'manual', 'docs-manifest'] as const),
  };
  if (has(source, 'importChain')) out.importChain = texts(source['importChain'], at(field, 'importChain'));
  if (has(source, 'profile')) out.profile = oneOf(source['profile'], at(field, 'profile'), ['app', 'docs'] as const);
  return out;
}

function coverage(value: unknown, field: string): Coverage {
  const source = record(value, field);
  return {
    changedFiles: texts(source['changedFiles'], at(field, 'changedFiles')),
    affected: list(source['affected'], at(field, 'affected'), affectedScreen),
    unresolvedFiles: texts(source['unresolvedFiles'], at(field, 'unresolvedFiles')),
    gaps: list(source['gaps'], at(field, 'gaps'), gap),
    nothingToCheck: flag(source['nothingToCheck'], at(field, 'nothingToCheck')),
  };
}

function receipt(value: unknown, field: string): Receipt {
  const source = record(value, field);
  const scanners = record(source['scannerVersions'], at(field, 'scannerVersions'));
  const scannersField = at(field, 'scannerVersions');
  const receiptCoverage = record(source['coverage'], at(field, 'coverage'));
  const coverageField = at(field, 'coverage');
  const summary = record(source['findingsSummary'], at(field, 'findingsSummary'));
  const summaryField = at(field, 'findingsSummary');
  const out: Receipt = {
    schemaVersion: oneOf(source['schemaVersion'], at(field, 'schemaVersion'), [1] as const),
    sourceTree: text(source['sourceTree'], at(field, 'sourceTree')),
    baseRevision: textOrNull(source['baseRevision'], at(field, 'baseRevision')),
    policyHash: text(source['policyHash'], at(field, 'policyHash')),
    runnerVersion: text(source['runnerVersion'], at(field, 'runnerVersion')),
    scannerVersions: {
      axeCore: text(scanners['axeCore'], at(scannersField, 'axeCore')),
      playwright: text(scanners['playwright'], at(scannersField, 'playwright')),
      chromium: text(scanners['chromium'], at(scannersField, 'chromium')),
    },
    surfaces: texts(source['surfaces'], at(field, 'surfaces')),
    coverage: {
      checked: texts(receiptCoverage['checked'], at(coverageField, 'checked')),
      notCovered: texts(receiptCoverage['notCovered'], at(coverageField, 'notCovered')),
    },
    applicability: list(source['applicability'], at(field, 'applicability'), (row, rowField) => {
      const entry = record(row, rowField);
      return {
        screenId: text(entry['screenId'], at(rowField, 'screenId')),
        applied: whole(entry['applied'], at(rowField, 'applied')),
        abstained: whole(entry['abstained'], at(rowField, 'abstained')),
      };
    }),
    verdict: oneOf(source['verdict'], at(field, 'verdict'), ['verified'] as const),
    findingsSummary: {
      new: whole(summary['new'], at(summaryField, 'new')),
      carried: whole(summary['carried'], at(summaryField, 'carried')),
      fixed: whole(summary['fixed'], at(summaryField, 'fixed')),
      unverified: whole(summary['unverified'], at(summaryField, 'unverified')),
    },
    activeWaivers: whole(source['activeWaivers'], at(field, 'activeWaivers')),
    mintedAt: text(source['mintedAt'], at(field, 'mintedAt')),
  };
  if (has(source, 'signature')) out.signature = text(source['signature'], at(field, 'signature'));
  return out;
}

function headroom(value: unknown, field: string): FloorHeadroom {
  const source = record(value, field);
  return {
    screenId: text(source['screenId'], at(field, 'screenId')),
    rule: text(source['rule'], at(field, 'rule')),
    recorded: whole(source['recorded'], at(field, 'recorded')),
    observed: whole(source['observed'], at(field, 'observed')),
  };
}

function unconfirmed(value: unknown, field: string): FloorUnconfirmed {
  const source = record(value, field);
  return {
    screenId: text(source['screenId'], at(field, 'screenId')),
    rules: texts(source['rules'], at(field, 'rules')),
    barriers: whole(source['barriers'], at(field, 'barriers')),
  };
}

/**
 * Checks a parsed JSON value against the Result contract and returns a Result built from the
 * checked fields. Throws InputRefusedError on the first field that does not match.
 *
 * The schema version and the two accessibility fields are checked first, in the order and with
 * the words CI already relies on: an accessibility verdict of approval_required, or an
 * accessibility exit code of 2, is the one forgery that would move a required status.
 */
export function parseResultDocument(value: unknown): Result {
  return worded(() => readResult(value), resultWording);
}

function readResult(value: unknown): Result {
  const source = record(value, '');
  if (source['schemaVersion'] !== 'usabl.result.v1') {
    refuse('schemaVersion', 'must be usabl.result.v1');
  }
  const accessibilityExitCode = source['accessibilityExitCode'];
  if (accessibilityExitCode !== 0 && accessibilityExitCode !== 1 && accessibilityExitCode !== 3 && accessibilityExitCode !== 4) {
    refuse('accessibilityExitCode', 'must be 0, 1, 3, or 4');
  }
  if (source['accessibilityVerdict'] === 'approval_required') {
    refuse('accessibilityVerdict', 'must not be approval_required, because that verdict is policy, not an accessibility outcome');
  }
  return {
    schemaVersion: 'usabl.result.v1',
    accessibilityExitCode,
    accessibilityVerdict: oneOfOrNull(source['accessibilityVerdict'], 'accessibilityVerdict', ['verified', 'regression', 'not_covered'] as const),
    verdict: oneOfOrNull(source['verdict'], 'verdict', ['verified', 'regression', 'not_covered', 'approval_required'] as const),
    summary: text(source['summary'], 'summary'),
    exitCode: oneOf(source['exitCode'], 'exitCode', [0, 1, 2, 3, 4, 5] as const),
    paidDownCount: whole(source['paidDownCount'], 'paidDownCount'),
    dirtyGuardedPaths: texts(source['dirtyGuardedPaths'], 'dirtyGuardedPaths'),
    screens: list(source['screens'], 'screens', screen),
    coverage: coverage(source['coverage'], 'coverage'),
    findings: list(source['findings'], 'findings', finding),
    receipt: source['receipt'] === null ? null : receipt(source['receipt'], 'receipt'),
    floorHeadroom: list(source['floorHeadroom'], 'floorHeadroom', headroom),
    floorUnconfirmed: list(source['floorUnconfirmed'], 'floorUnconfirmed', unconfirmed),
  };
}
