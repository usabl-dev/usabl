/**
 * App finding to source-file mapping.
 *
 * Findings report a DOM node; developers edit React/TSX. This module bridges that gap with the
 * best honest location available:
 *   1. renderer  - data-source-file/line on the element (Vite dev transform or DOM attrs)
 *   2. import-chain - the changed UI file on the route-graph path to this screen
 *   3. coverage - changed UI files tied to this screen, or disclosed as candidates on wide-blast
 */
import type {
  AffectedScreen,
  AppSourceMapping,
  Coverage,
  Finding,
} from "../contracts/index.js";
import { readRenderedSourceFromExtra } from "../primitives/rendered-source.js";

export type { AppSourceMapping };

function changedFilesForScreen(
  screen: AffectedScreen | undefined,
  coverage: Coverage
): string[] {
  if (screen === undefined) {
    return [];
  }

  // Wide-blast can touch every route: disclose every changed UI file as candidates for that screen.
  if (screen.provenance === "wide-blast") {
    return [...coverage.changedFiles];
  }

  // Manual or other surfaces without import chain: only attribute when exactly one file changed.
  if (coverage.changedFiles.length === 1) {
    return [...coverage.changedFiles];
  }

  return [];
}

export function mapFindingToAppSource(
  finding: Finding,
  coverage: Coverage,
  screen: AffectedScreen | undefined
): AppSourceMapping | null {
  if (finding.docsSource !== undefined) {
    return null;
  }

  const rendered = readRenderedSourceFromExtra(finding);
  if (rendered !== null) {
    return {
      tier: "renderer",
      file: rendered.file,
      line: rendered.line,
      candidates: [rendered.file],
    };
  }

  const chain = screen?.importChain;
  if (chain !== undefined && chain.length > 0) {
    const changedFile =
      chain.length > 1 ? chain[chain.length - 1] ?? null : chain[0] ?? null;
    if (changedFile !== null) {
      return {
        tier: "import-chain",
        file: changedFile,
        line: null,
        candidates: [...new Set(chain)],
      };
    }
  }

  if (screen !== undefined) {
    const candidates = changedFilesForScreen(screen, coverage);
    if (candidates.length > 0) {
      return {
        tier: "coverage",
        file: candidates[0] ?? null,
        line: null,
        candidates,
      };
    }
  }

  return null;
}

export function enrichAppFindings(
  findings: Finding[],
  coverage: Coverage
): Finding[] {
  const screenById = new Map(
    coverage.affected.map((screen) => [screen.screenId, screen])
  );
  return findings.map((finding) => {
    if (finding.docsSource !== undefined || finding.appSource !== undefined) {
      return finding;
    }
    const appSource = mapFindingToAppSource(
      finding,
      coverage,
      screenById.get(finding.screenId)
    );
    return appSource === null ? finding : { ...finding, appSource };
  });
}
