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
  severity: Finding['severity'];
  status: Finding['status'];
  count: number;
  representative: Finding;
}

export interface NoiseBudgetView {
  groups: CollapsedFindingGroup[];
  totalCount: number;
  shownCount: number;
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

function groupKey(finding: Finding): string {
  return `${finding.screenId}|${finding.layer}|${finding.rule}`;
}

function groupRank(group: CollapsedFindingGroup): string {
  return [
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
  const perSurface = config?.noiseBudget?.perSurface?.[screenId];
  if (perSurface !== undefined) {
    return perSurface;
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
  for (const [key, bucket] of byKey) {
    const [screenId, layer, rule] = key.split('|');
    if (screenId === undefined || layer === undefined || rule === undefined) {
      continue;
    }
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
    groups.push({
      screenId,
      layer,
      rule,
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

export function formatShowAllHint(counts: ShowAllHintCounts): string {
  const { totalFindingCount, shownGroupCount, totalGroupCount } = counts;
  if (shownGroupCount < totalGroupCount) {
    return `${SHOW_ALL_JSON_HINT} for all ${totalFindingCount} findings (${shownGroupCount} of ${totalGroupCount} rule groups shown).`;
  }
  if (totalFindingCount > shownGroupCount) {
    return `${SHOW_ALL_JSON_HINT} for all ${totalFindingCount} findings (${totalGroupCount} rule groups; some rules repeat across elements).`;
  }
  return `${SHOW_ALL_JSON_HINT} for all ${totalFindingCount} findings.`;
}

export function applyNoiseBudget(
  findings: readonly Finding[],
  maxShown: number,
): NoiseBudgetView {
  if (findings.length === 0) {
    return {
      groups: [],
      totalCount: 0,
      shownCount: 0,
      collapsed: false,
      maxShown,
      showAllHint: null,
    };
  }

  const groups = collapseFindingsByRule(findings);
  const collapsed = findings.length > maxShown;
  if (!collapsed) {
    return {
      groups,
      totalCount: findings.length,
      shownCount: groups.length,
      collapsed: false,
      maxShown,
      showAllHint: null,
    };
  }

  const shown = groups.slice(0, maxShown);
  return {
    groups: shown,
    totalCount: findings.length,
    shownCount: shown.length,
    collapsed: true,
    maxShown,
    showAllHint: formatShowAllHint({
      totalFindingCount: findings.length,
      shownGroupCount: shown.length,
      totalGroupCount: groups.length,
    }),
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

  for (const [screenId, screenFindings] of byScreen) {
    const allScreenGroups = collapseFindingsByRule(screenFindings);
    totalGroupCount += allScreenGroups.length;
    const view = applyNoiseBudget(screenFindings, resolveBudgetForSurface(config, screenId));
    totalCount += view.totalCount;
    allGroups.push(...view.groups);
    if (view.collapsed) {
      collapsed = true;
    }
  }

  const sorted = sortBy(allGroups, (group) => groupRank(group));
  return {
    groups: sorted,
    totalCount,
    shownCount: sorted.length,
    collapsed,
    maxShown: resolveNoiseBudgetDefault(config),
    showAllHint: collapsed
      ? formatShowAllHint({
          totalFindingCount: totalCount,
          shownGroupCount: sorted.length,
          totalGroupCount,
        })
      : null,
  };
}

export function formatCollapsedGroupHeadline(group: CollapsedFindingGroup): string {
  const countSuffix = group.count > 1 ? ` (×${group.count})` : '';
  return `[${group.severity}] ${group.screenId}/${group.layer}/${group.rule}${countSuffix}`;
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
    const perSurface: Record<string, number> = {};
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
