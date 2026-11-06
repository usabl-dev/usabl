/**
 * Normalizes raw axe-core results into the shape the axe mapping reads.
 * Raw results come from a scanner the compiler never checked: open-source axe run by the browser
 * driver, or a commercial engine that returns axe-shaped results. Every field is read as the
 * untyped value it really is, and input that is not an array yields nothing.
 * This unit is pure. It never mints a verdict and never decides whether a result matters.
 */
import type { AxeIssue, AxeRuleSummary } from './index.js';

/**
 * The four buckets of one axe run. axe classifies every rule it loaded, not only the ones that
 * produced findings. Keeping the passes and inapplicable buckets is what lets a later reader tell
 * a rule that ran and passed from a rule that never matched anything on this screen.
 */
export interface AxeRunResultBuckets {
  violations: AxeIssue[];
  incomplete: AxeIssue[];
  passes: AxeRuleSummary[];
  inapplicable: AxeRuleSummary[];
}

function getProp(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  return Reflect.get(value, key);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function mapAxeCheck(rawCheck: unknown): { data?: unknown } {
  const data = getProp(rawCheck, 'data');
  return data === undefined ? {} : { data };
}

function mapAxeNode(rawNode: unknown): AxeIssue['nodes'][number] {
  const rawTarget = getProp(rawNode, 'target');
  const target = Array.isArray(rawTarget) ? rawTarget.map((entry) => String(entry)) : [];
  // axe names an element in a frame or a shadow root with one part per boundary: one entry per
  // frame, and an entry that is a list for the path into shadow roots. The joined target above
  // stays the element path a finding is named by. The parts are kept beside it, only for an element
  // past a boundary, so its row can be read where it really is.
  const parts = Array.isArray(rawTarget)
    ? rawTarget.map((entry) => (Array.isArray(entry) ? entry.map((part) => String(part)) : [String(entry)]))
    : [];
  const crossesBoundary = parts.length > 1 || parts.some((level) => level.length > 1);
  const html = readString(getProp(rawNode, 'html'));
  const failureSummary = readString(getProp(rawNode, 'failureSummary'));
  const rawAny = getProp(rawNode, 'any');
  const checks = Array.isArray(rawAny) ? rawAny.map((check) => mapAxeCheck(check)) : [];

  return {
    target,
    ...(crossesBoundary ? { targetParts: parts } : {}),
    ...(html === null ? {} : { html }),
    ...(failureSummary === null ? {} : { failureSummary }),
    ...(checks.length === 0 ? {} : { any: checks }),
  };
}

function mapAxeIssues(rawIssues: unknown): AxeIssue[] {
  if (!Array.isArray(rawIssues)) {
    return [];
  }

  const issues: AxeIssue[] = [];
  for (const rawIssue of rawIssues) {
    const id = readString(getProp(rawIssue, 'id'));
    const description = readString(getProp(rawIssue, 'description'));
    if (id === null || description === null) {
      continue;
    }

    const rawImpact = readString(getProp(rawIssue, 'impact'));
    const impact =
      rawImpact === 'critical' || rawImpact === 'serious' || rawImpact === 'moderate' || rawImpact === 'minor'
        ? rawImpact
        : undefined;

    const rawNodes = getProp(rawIssue, 'nodes');
    const nodes = Array.isArray(rawNodes) ? rawNodes.map((node) => mapAxeNode(node)) : [];

    issues.push({
      id,
      description,
      nodes,
      ...(impact === undefined ? {} : { impact }),
    });
  }

  return issues;
}

/**
 * Maps an axe rule bucket to the light record applicability needs: which rule, and how many
 * elements it matched. Nodes are counted, never mapped, because a passing rule can carry
 * hundreds of them per screen and none of them are evidence of anything.
 *
 * Exported so the mapping can be proven without a browser. Same defensive contract as
 * mapAxeIssues: raw axe output is untyped and input that is not an array yields nothing. Only
 * the rule id is required, because it is the whole identity of the record. Nothing else about
 * the entry is read, so nothing else can decide whether the entry is kept.
 */
export function mapAxeRuleSummaries(rawRules: unknown): AxeRuleSummary[] {
  if (!Array.isArray(rawRules)) {
    return [];
  }

  const summaries: AxeRuleSummary[] = [];
  for (const rawRule of rawRules) {
    const id = readString(getProp(rawRule, 'id'));
    if (id === null) {
      continue;
    }

    // inapplicable entries always arrive with an empty node list, but the length is read rather
    // than assumed so this stays true of whatever bucket it is handed.
    const rawNodes = getProp(rawRule, 'nodes');
    const nodeCount = Array.isArray(rawNodes) ? rawNodes.length : 0;

    summaries.push({ id, nodeCount });
  }

  return summaries;
}

/**
 * Maps the results object axe returns to the record the axe mapping reads. The same defensive
 * contract as the bucket mappings above: anything that is not the expected shape reads as empty.
 * A caller that must not read a missing bucket as a clean one checks the raw shape first.
 */
export function normalizeAxeResults(raw: unknown): AxeRunResultBuckets {
  return {
    violations: mapAxeIssues(getProp(raw, 'violations')),
    incomplete: mapAxeIssues(getProp(raw, 'incomplete')),
    passes: mapAxeRuleSummaries(getProp(raw, 'passes')),
    inapplicable: mapAxeRuleSummaries(getProp(raw, 'inapplicable')),
  };
}
