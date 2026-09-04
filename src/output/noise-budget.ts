/**
 * Noise-budget projection for bounded operator surfaces.
 * When findings exceed the configured budget, collapse by rule with counts and
 * surface a hint to `usabl check --json` for the full list. This unit formats
 * only; it never mints a verdict or drops findings from the gated Result.
 */
import type { Finding, NoiseBudgetConfig, UsablConfig } from '../contracts/index.js';
import { sortBy } from '../primitives/sortKey.js';

export const DEFAULT_NOISE_BUDGET = 5;

export const SHOW_ALL_JSON_HINT =
  'Run `usabl check --json` for the full list';

export interface CollapsedFindingGroup {
  screenId: string;
  layer: string;
  rule: string;
  evidenceClass: Finding['evidenceClass'];
  severity: Finding['severity'];
  status: Finding['status'];
  count: number;
  representative: Finding;
}

export interface NoiseBudgetView {
  groups: CollapsedFindingGroup[];
  totalCount: number;
  shownCount: number;
  // grouped: rules repeated, so a shown group stands for more than one finding.
  // collapsed: the budget hid whole groups. Either one means the shown groups do not map one to one
  // to findings, so the total count must be disclosed. The overlay reads both to stay consistent.
  grouped: boolean;
  collapsed: boolean;
  maxShown: number;
  showAllHint: string | null;
}

const STATUS_RANK: Record<Finding['status'], number> = {
  new: 0,
  carried: 1,
  waived: 2,
  fixed: 3,
};

const SEVERITY_RANK: Record<Finding['severity'], number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

// Gating (deterministic) findings rank before advisory ones, so a collapsed view never shows an
// advisory finding ahead of a real gating barrier or lets advisory noise push a barrier out of the
// budget. Only deterministic evidence gates the verdict.
const EVIDENCE_RANK: Record<Finding['evidenceClass'], number> = {
  deterministic: 0,
  'human-confirmed': 1,
  'model-judgment': 2,
  preview: 3,
};

// Injective key: JSON-encode the tuple so a '|' inside a screenId, layer, or rule cannot collide
// two distinct groups into one (the same delimiter trap the identity key avoids). evidenceClass is
// part of the key so a deterministic finding and an advisory finding of the same rule never merge.
function groupKey(finding: Finding): string {
  return JSON.stringify([finding.screenId, finding.layer, finding.rule, finding.evidenceClass]);
}

function groupRank(group: CollapsedFindingGroup): string {
  return [
    String(EVIDENCE_RANK[group.evidenceClass]),
    String(STATUS_RANK[group.status]),
    String(SEVERITY_RANK[group.severity]),
    group.screenId,
    group.layer,
    group.rule,
  ].join('\0');
}

export function resolveNoiseBudgetDefault(config: UsablConfig | undefined): number {
  const configured = config?.noiseBudget?.default;
  if (configured === undefined) {
    return DEFAULT_NOISE_BUDGET;
  }
  return configured;
}

export function resolveBudgetForSurface(
  config: UsablConfig | undefined,
  screenId: string,
): number {
  // Object.hasOwn, not a bare index, so a screen id like "constructor" or "__proto__" reads an own
  // configured budget only, never an inherited prototype member (which would be a function, not a
  // number, and silently disable the budget for that screen).
  const perSurface = config?.noiseBudget?.perSurface;
  if (perSurface !== undefined && Object.hasOwn(perSurface, screenId)) {
    return perSurface[screenId] as number;
  }
  return resolveNoiseBudgetDefault(config);
}

export function collapseFindingsByRule(findings: readonly Finding[]): CollapsedFindingGroup[] {
  const byKey = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = groupKey(finding);
    const bucket = byKey.get(key) ?? [];
    bucket.push(finding);
    byKey.set(key, bucket);
  }

  const groups: CollapsedFindingGroup[] = [];
  for (const bucket of byKey.values()) {
    const representative = sortBy(bucket, (finding) =>
      [
        String(STATUS_RANK[finding.status]),
        String(SEVERITY_RANK[finding.severity]),
        finding.elementKey ?? '',
      ].join('\0'),
    )[0];
    if (representative === undefined) {
      continue;
    }
    // Take the group fields from the representative, not from splitting the key. All findings in a
    // bucket share these values, and reading them directly avoids decoding the injective key.
    groups.push({
      screenId: representative.screenId,
      layer: representative.layer,
      rule: representative.rule,
      evidenceClass: representative.evidenceClass,
      severity: representative.severity,
      status: representative.status,
      count: bucket.length,
      representative,
    });
  }

  return sortBy(groups, (group) => groupRank(group));
}

export interface ShowAllHintCounts {
  totalFindingCount: number;
  shownGroupCount: number;
  totalGroupCount: number;
}

// noun names the set being counted. Surfaces that collapse only the gating lane pass
// "gating findings" so the count is not mislabeled as the whole Result when advisory findings also
// exist. The overlay counts all findings and keeps the default.
export function formatShowAllHint(counts: ShowAllHintCounts, noun = 'findings'): string {
  const { totalFindingCount, shownGroupCount, totalGroupCount } = counts;
  if (shownGroupCount < totalGroupCount) {
    return `${SHOW_ALL_JSON_HINT} for all ${totalFindingCount} ${noun} (${shownGroupCount} of ${totalGroupCount} rule groups shown).`;
  }
  if (totalFindingCount > shownGroupCount) {
    return `${SHOW_ALL_JSON_HINT} for all ${totalFindingCount} ${noun} (${totalGroupCount} rule groups; some rules repeat across elements).`;
  }
  return `${SHOW_ALL_JSON_HINT} for all ${totalFindingCount} ${noun}.`;
}

export function applyNoiseBudget(
  findings: readonly Finding[],
  maxShown: number,
  noun = 'findings',
): NoiseBudgetView {
  if (findings.length === 0) {
    return {
      groups: [],
      totalCount: 0,
      shownCount: 0,
      grouped: false,
      collapsed: false,
      maxShown,
      showAllHint: null,
    };
  }

  const groups = collapseFindingsByRule(findings);
  // grouped: a rule repeated, so a shown group stands for more than one finding.
  // collapsed: the budget hides whole groups. Slice on group count so the flag and the slice agree.
  const grouped = groups.length < findings.length;
  const collapsed = groups.length > maxShown;
  const shown = collapsed ? groups.slice(0, maxShown) : groups;
  const showAllHint =
    grouped || collapsed
      ? formatShowAllHint(
          {
            totalFindingCount: findings.length,
            shownGroupCount: shown.length,
            totalGroupCount: groups.length,
          },
          noun,
        )
      : null;
  return {
    groups: shown,
    totalCount: findings.length,
    shownCount: shown.length,
    grouped,
    collapsed,
    maxShown,
    showAllHint,
  };
}

export function applyNoiseBudgetPerSurface(
  findings: readonly Finding[],
  config: UsablConfig | undefined,
): NoiseBudgetView {
  const byScreen = new Map<string, Finding[]>();
  for (const finding of findings) {
    const bucket = byScreen.get(finding.screenId) ?? [];
    bucket.push(finding);
    byScreen.set(finding.screenId, bucket);
  }

  const allGroups: CollapsedFindingGroup[] = [];
  let totalCount = 0;
  let totalGroupCount = 0;
  let collapsed = false;
  let grouped = false;

  for (const [screenId, screenFindings] of byScreen) {
    const allScreenGroups = collapseFindingsByRule(screenFindings);
    totalGroupCount += allScreenGroups.length;
    const view = applyNoiseBudget(screenFindings, resolveBudgetForSurface(config, screenId));
    totalCount += view.totalCount;
    allGroups.push(...view.groups);
    if (view.collapsed) {
      collapsed = true;
    }
    if (view.grouped) {
      grouped = true;
    }
  }

  const sorted = sortBy(allGroups, (group) => groupRank(group));
  return {
    groups: sorted,
    totalCount,
    shownCount: sorted.length,
    grouped,
    collapsed,
    maxShown: resolveNoiseBudgetDefault(config),
    // Disclose the total whenever grouping or truncation means the shown groups do not map one to
    // one to findings, so the overlay's group list and its finding count never disagree silently.
    showAllHint:
      grouped || collapsed
        ? formatShowAllHint({
            totalFindingCount: totalCount,
            shownGroupCount: sorted.length,
            totalGroupCount,
          })
        : null,
  };
}

export function formatCollapsedGroupHeadline(group: CollapsedFindingGroup): string {
  // Show status alongside severity so a reader can tell a new gating barrier from carried debt or a
  // waived item at a glance, rather than judging a collapsed group by severity alone.
  const countSuffix = group.count > 1 ? ` (×${group.count})` : '';
  return `[${group.status} ${group.severity}] ${group.screenId}/${group.layer}/${group.rule}${countSuffix}`;
}

export function parseNoiseBudgetConfig(raw: unknown): NoiseBudgetConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('noiseBudget must be an object');
  }
  const record = raw as Record<string, unknown>;
  const parsed: NoiseBudgetConfig = {};

  const defaultBudget = record['default'];
  if (defaultBudget !== undefined) {
    parsed.default = expectPositiveWholeNumber(defaultBudget, 'noiseBudget.default');
  }

  const perSurfaceRaw = record['perSurface'];
  if (perSurfaceRaw !== undefined) {
    if (typeof perSurfaceRaw !== 'object' || perSurfaceRaw === null || Array.isArray(perSurfaceRaw)) {
      throw new Error('noiseBudget.perSurface must be an object');
    }
    // Null-prototype so a key like "__proto__" is stored as an own budget rather than mutating the
    // prototype chain, and reads stay own-property lookups.
    const perSurface: Record<string, number> = Object.create(null);
    for (const [screenId, value] of Object.entries(perSurfaceRaw)) {
      perSurface[screenId] = expectPositiveWholeNumber(value, `noiseBudget.perSurface.${screenId}`);
    }
    parsed.perSurface = perSurface;
  }

  return parsed;
}

function expectPositiveWholeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive whole number`);
  }
  return value;
}
