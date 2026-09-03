/**
 * Format source locations for terminal and markdown projections.
 */
import type {
  AppSourceMapping,
  DocsSourceMapping,
} from "../contracts/index.js";

export function formatDocsSourceLocation(source: DocsSourceMapping): string {
  const file = source.file ?? "";
  if (source.construct !== null) {
    return `${file} -> ${source.construct}`;
  }
  if (source.line !== null) {
    return `${file}:${source.line}`;
  }
  return file;
}

export function formatAppSourceLocation(source: AppSourceMapping): string {
  const file = source.file ?? "";
  if (source.line !== null) {
    return `${file}:${source.line}`;
  }
  return file;
}

export function editorDeepLink(
  workspaceRoot: string | null,
  source: AppSourceMapping
): string | null {
  if (source.file === null || source.file === "") {
    return null;
  }
  const line = source.line ?? 1;
  const relative = source.file.replace(/^\//, "");
  const absolute =
    workspaceRoot === null || workspaceRoot === ""
      ? relative
      : `${workspaceRoot.replace(/\/$/, "")}/${relative}`;
  return `vscode://file/${absolute}:${line}:1`;
}
