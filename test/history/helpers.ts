/**
 * Small builders for the debt history tests. Every value is low entropy on purpose: the repository
 * history is scanned for secrets, and a random-looking hash in a fixture reads like one.
 */
import type { Coverage, Draft, EvidenceFloor, FloorEntry, GateInput, ScreenScan } from '../../src/contracts/index.js';
import { computeIdentity } from '../../src/primitives/identity.js';
import { floorHashOf, HISTORY_SCHEMA, identityId, type HistoryRecord, type HistoryScreen } from '../../src/history/record.js';

export const COMMIT_A = 'a'.repeat(40);
export const COMMIT_B = 'b'.repeat(40);
export const COMMIT_C = 'c'.repeat(40);
export const COMMIT_D = 'd'.repeat(40);
export const POLICY = '0'.repeat(64);
export const SCANNERS = { axeCore: '4.0.0', playwright: '1.0.0', chromium: '100.0' };

/** An unnamed icon button in one keyed table row of the jobs screen. */
export function rowButton(row: string, over: Partial<Draft> = {}): Draft {
  return {
    rule: 'button-name', layer: 'axe', severity: 'critical', evidenceClass: 'deterministic',
    screenId: 'jobs', elementPath: `table > tbody > tr:nth-child(1) > td > button`,
    elementName: null, role: 'button',
    whatUserExperiences: 'The button has no name', why: '', fix: 'Name the button',
    evidence: { extra: { rowScope: { table: 'table', row: `row-${row}`, role: 'button', path: 'td>button' } } },
    confidence: 'fail', ...over,
  };
}

/** A dialog that neutralizes to one structural identity wherever it sits. */
export function dialogAt(nth: number, over: Partial<Draft> = {}): Draft {
  return {
    rule: 'pf-focus-into-dialog', layer: 'pf', severity: 'serious', evidenceClass: 'deterministic',
    screenId: 'clusters', elementPath: `main > div:nth-child(${nth}) > section`,
    elementName: null, role: 'dialog',
    whatUserExperiences: 'Focus stays behind the dialog', why: '', fix: 'Move focus into the dialog',
    evidence: {}, confidence: 'fail', ...over,
  };
}

export function entryFor(draft: Draft, count: number): FloorEntry {
  const identity = computeIdentity(draft);
  return {
    screenId: draft.screenId, layer: draft.layer, rule: draft.rule,
    elementKey: identity.elementKey, identityBasis: identity.identityBasis, count,
  };
}

export function floorOf(entries: FloorEntry[], version: 1 | 2 | 3 = 3): EvidenceFloor {
  return { version, entries };
}

/** One full screen in a record, with these counts per floor entry. Entries left out are not observed. */
export function fullScreen(screenId: string, counts: Array<[FloorEntry, number]>): HistoryScreen {
  return {
    screenId,
    coverage: 'full',
    identities: counts
      .map(([entry, count]) => ({ id: identityId(entry), rule: entry.rule, basis: entry.identityBasis, count }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function recordOf(
  floor: EvidenceFloor,
  screens: HistoryScreen[],
  over: Partial<HistoryRecord> = {},
): HistoryRecord {
  return {
    schema: HISTORY_SCHEMA,
    time: '2026-10-01T00:00:00.000Z',
    commit: COMMIT_A,
    sourceTree: 'tree-a',
    policyHash: POLICY,
    runnerVersion: '0.3.0-test',
    scannerVersions: SCANNERS,
    floorHash: floorHashOf(floor),
    screens,
    ...over,
  };
}

export function scanOf(screenId: string, drafts: Draft[], over: Partial<ScreenScan> = {}): ScreenScan {
  return {
    screenId, url: `http://127.0.0.1:5173/${screenId}`, stops: [], drafts, gaps: [], applicability: [],
    reachedSelectorPresent: true, reachedWhenSelector: '#content', ...over,
  };
}

export function coverageFor(screenIds: string[]): Coverage {
  return {
    changedFiles: ['src/App.tsx'],
    affected: screenIds.map((screenId) => ({ screenId, url: `http://127.0.0.1:5173/${screenId}`, provenance: 'manual' as const })),
    unresolvedFiles: [], gaps: [], nothingToCheck: false,
  };
}

/** A gate input for one run over these screens, with the readiness signal held on each. */
export function gateInputFor(floor: EvidenceFloor, drafts: Draft[], screenIds: string[]): GateInput {
  return {
    coverage: coverageFor(screenIds),
    guardDivergedPaths: [],
    drafts,
    floor,
    waivers: [],
    now: '2026-10-28T00:00:00.000Z',
    cleanlyScannedScreens: new Set(screenIds),
    renderEvidence: new Map(screenIds.map((screenId) => [screenId, { signalHeld: true, elementSlots: new Set<string>() }])),
  };
}

/**
 * An in-memory history store. `main` lists each main commit with its ancestors, so isAncestor can
 * answer without a repository. History commits are numbered "h1", "h2", and so on.
 */
export function makeFakeHistory(spec: {
  ref?: string;
  refs?: Record<string, string>;
  main?: Record<string, string[]>;
  commits?: Record<string, Record<string, string>>;
} = {}) {
  const ref = spec.ref ?? 'origin/usabl/history';
  const refs: Record<string, string> = { ...(spec.refs ?? {}) };
  const commits: Record<string, Record<string, string>> = { ...(spec.commits ?? {}) };
  const main = spec.main ?? {};
  const branches: Record<string, string> = {};
  let next = Object.keys(commits).length + 1;
  return {
    branches,
    commits,
    refs,
    writer: {
      ref,
      resolveCommit: async (name: string) => refs[name] ?? (main[name] !== undefined || commits[name] !== undefined ? name : null),
      listFiles: async (commit: string) => Object.keys(commits[commit] ?? {}).sort(),
      readFile: async (commit: string, path: string) => commits[commit]?.[path] ?? null,
      isAncestor: async (commit: string, of: string) => commit === of || (main[of] ?? []).includes(commit),
      commitFile: async (parent: string | null, path: string, contents: string) => {
        const id = `h${next}`;
        next += 1;
        commits[id] = { ...(parent === null ? {} : commits[parent]), [path]: contents };
        return id;
      },
      setBranch: async (branch: string, commit: string) => {
        branches[branch] = commit;
      },
    },
  };
}
