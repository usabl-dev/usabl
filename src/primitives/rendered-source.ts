/**
 * Read renderer-tier source hints that cooperating markup may carry on a finding.
 * Used by docs and app source mapping. Never throws.
 */
import type { Draft } from "../contracts/index.js";

export interface RenderedSourceHint {
  file: string;
  line: number | null;
}

function extraHtml(finding: Draft): string | null {
  const html = finding.evidence.extra?.["html"];
  return typeof html === "string" ? html : null;
}

function attrOf(html: string, name: string): string | null {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`,
    "i"
  ).exec(html);
  if (!match) {
    return null;
  }
  return match[2] ?? match[3] ?? null;
}

function readInteger(value: string | null): number | null {
  if (value === null || value === "") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function readRenderedSourceFromExtra(
  finding: Draft
): RenderedSourceHint | null {
  const extra = finding.evidence.extra;
  const extraFile = extra?.["sourceFile"];
  if (typeof extraFile === "string" && extraFile !== "") {
    const lineValue = extra?.["sourceLine"];
    const line =
      typeof lineValue === "number" &&
      Number.isFinite(lineValue) &&
      lineValue > 0
        ? lineValue
        : typeof lineValue === "string"
        ? readInteger(lineValue)
        : null;
    return { file: extraFile, line };
  }

  const html = extraHtml(finding);
  if (html === null) {
    return null;
  }
  const file = attrOf(html, "data-source-file");
  if (file === null || file === "") {
    return null;
  }
  return { file, line: readInteger(attrOf(html, "data-source-line")) };
}
