/**
 * `usabl drift design` lists the approved requirements whose design file changed after they were
 * recorded. Each requirement drafted from a design keeps the file, node, and version it came from.
 * This reads each file's current version from Figma and compares it with the recorded one. A
 * change anywhere in the file flags every approved requirement drafted from that version, and the
 * report says when the node a requirement came from is gone. Unapproved drafts are left out: no one
 * has signed off on them, so a person reviews them against the current design anyway.
 *
 * It never changes a requirement and never decides a verdict. A fetch that fails, for any reason,
 * stops the command with exit 2: it is never read as "no drift". The token is never printed.
 */
import type { FsGlob, UsablConfig } from '../contracts/index.js';
import type { FigmaNode } from '../import/figma/types.js';
import { figmaApiBase, FigmaFetchError, fetchFigmaFile } from '../import/figma/fetch.js';
import { loadRequirements } from '../intake/load.js';
import { firstLine } from '../primitives/first-line.js';
import { neutralize } from '../primitives/neutralize.js';
import { scrubString } from '../surfaces/scrub.js';

export interface DesignSourceRef {
  requirementId: string;
  file: string;
  node: string;
  version: string;
}

export interface CurrentDesignFile {
  version: string;
  nodes: ReadonlySet<string>;
}

export interface DriftedRequirement {
  id: string;
  node: string;
  nodeGone: boolean;
}

export interface DesignDriftGroup {
  file: string;
  recorded: string;
  current: string;
  requirements: DriftedRequirement[];
}

export interface DesignDrift {
  changed: DesignDriftGroup[];
  // Requirements whose file has no current version. They were not checked, so the run cannot
  // say there is no drift.
  unchecked: string[];
  hasDrift: boolean;
}

export interface DesignDriftOutcome {
  exitCode: 0 | 1 | 2;
  stdout?: string;
  stderr?: string;
}

const NOT_CHECKED = 'Design drift was not checked.';

// Code unit order, so the report reads the same on every machine and in every locale.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Groups by file and recorded version, so requirements drafted from different versions of one
// file each report against the version they were drafted from.
export function computeDesignDrift(
  sources: readonly DesignSourceRef[],
  current: Readonly<Record<string, CurrentDesignFile>>,
): DesignDrift {
  const groups = new Map<string, DesignDriftGroup>();
  const unchecked: string[] = [];
  for (const source of sources) {
    const now = Object.hasOwn(current, source.file) ? current[source.file] : undefined;
    if (now === undefined) {
      unchecked.push(source.requirementId);
      continue;
    }
    if (now.version === source.version) {
      continue;
    }
    const key = JSON.stringify([source.file, source.version]);
    const group = groups.get(key) ?? { file: source.file, recorded: source.version, current: now.version, requirements: [] };
    group.requirements.push({ id: source.requirementId, node: source.node, nodeGone: !now.nodes.has(source.node) });
    groups.set(key, group);
  }
  const changed = [...groups.values()]
    .map((group) => ({ ...group, requirements: [...group.requirements].sort((a, b) => byCodeUnit(a.id, b.id)) }))
    .sort((a, b) => byCodeUnit(a.file, b.file) || byCodeUnit(a.recorded, b.recorded));
  return { changed, unchecked: [...unchecked].sort(byCodeUnit), hasDrift: changed.length > 0 };
}

export function formatDesignDriftReport(drift: DesignDrift): string {
  if (!drift.hasDrift && drift.unchecked.length === 0) {
    return 'No design drift. Every approved requirement matches the current version of its design file.\n';
  }
  const lines: string[] = [];
  for (const group of drift.changed) {
    lines.push(
      `The design file ${neutralize(group.file)} changed after these requirements were approved (version ${neutralize(group.recorded)} to ${neutralize(group.current)}):`,
    );
    for (const requirement of group.requirements) {
      const gone = requirement.nodeGone ? ` (its design node ${neutralize(requirement.node)} is no longer in the file)` : '';
      lines.push(`  ${neutralize(requirement.id)}${gone}`);
    }
    lines.push('Review the design change, then update or import these requirements again.');
  }
  if (drift.unchecked.length > 0) {
    lines.push(`Design drift was not checked for: ${drift.unchecked.map((id) => neutralize(id)).join(', ')}.`);
  }
  return `${lines.join('\n')}\n`;
}

function nodeIds(root: FigmaNode): Set<string> {
  const ids = new Set<string>();
  const pending: FigmaNode[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    ids.add(node.id);
    pending.push(...(node.children ?? []));
  }
  return ids;
}

export async function runDesignDrift(
  fs: FsGlob,
  config: UsablConfig,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch = fetch,
): Promise<DesignDriftOutcome> {
  const token = env['FIGMA_TOKEN'] ?? '';
  // Every line the command prints, the report included, passes through here, so no path can print
  // the token or a control sequence. Each line is scrubbed on its own, so the report keeps its lines.
  const clean = (text: string): string =>
    (token === '' ? text : text.split(token).join('[token]'))
      .split('\n')
      .map((line) => scrubString(line))
      .join('\n');
  const fail = (message: string): DesignDriftOutcome => ({
    exitCode: 2,
    stderr: `${clean(`usabl drift design: ${message.replace(/\n/gu, ' ')} ${NOT_CHECKED}`)}\n`,
  });

  if (config.requirements === undefined) {
    return {
      exitCode: 0,
      stdout: clean(
        'No requirements folder is configured: usabl.config.json has no "requirements" path, so no requirement records a design source.\n',
      ),
    };
  }
  const loaded = await loadRequirements(fs, config);
  if (!loaded.ok) {
    return fail(loaded.reason);
  }
  const sources: DesignSourceRef[] = [];
  for (const requirement of loaded.bundle.requirements) {
    if (requirement.approved && requirement.source !== undefined) {
      const { file, node, version } = requirement.source;
      sources.push({ requirementId: requirement.id, file, node, version });
    }
  }
  if (sources.length === 0) {
    return { exitCode: 0, stdout: clean('No approved requirement records a design source.\n') };
  }
  if (token === '') {
    return fail('Set FIGMA_TOKEN to a Figma personal access token that can read the design files.');
  }
  const base = figmaApiBase(env);
  if (!base.ok) {
    return fail(base.message);
  }

  const current: Record<string, CurrentDesignFile> = {};
  for (const file of [...new Set(sources.map((source) => source.file))].sort(byCodeUnit)) {
    try {
      const read = await fetchFigmaFile(base.base, file, token, fetchImpl);
      current[file] = { version: read.version, nodes: nodeIds(read.document) };
    } catch (error: unknown) {
      if (error instanceof FigmaFetchError) {
        return fail(error.message);
      }
      const message = error instanceof Error ? firstLine(error.message) : '';
      return fail(`The design file ${file} could not be read: ${message || 'no message'}`);
    }
  }

  const drift = computeDesignDrift(sources, current);
  if (drift.unchecked.length > 0) {
    return { exitCode: 2, stderr: clean(formatDesignDriftReport(drift)) };
  }
  return { exitCode: drift.hasDrift ? 1 : 0, stdout: clean(formatDesignDriftReport(drift)) };
}
