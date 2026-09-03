/**
 * Attach renderer-tier source hints from live DOM attributes onto provider drafts.
 * Reads data-source-file and data-source-line when present. Never throws.
 */
import type { Draft, Page } from "../contracts/index.js";
import { readRenderedSourceFromExtra } from "../primitives/rendered-source.js";

async function readDomSource(
  page: Page,
  selector: string
): Promise<{ sourceFile: string; sourceLine: number | null } | null> {
  const trimmed = selector.trim();
  if (trimmed === "") {
    return null;
  }
  const file = await page.getAttribute(trimmed, "data-source-file");
  if (file === null || file === "") {
    return null;
  }
  const lineRaw = await page.getAttribute(trimmed, "data-source-line");
  const parsed =
    lineRaw === null || lineRaw === "" ? null : Number.parseInt(lineRaw, 10);
  const sourceLine =
    parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  return { sourceFile: file, sourceLine };
}

export async function attachDomSourceToDrafts(
  page: Page,
  drafts: Draft[]
): Promise<Draft[]> {
  const enriched: Draft[] = [];
  for (const draft of drafts) {
    if (readRenderedSourceFromExtra(draft) !== null) {
      enriched.push(draft);
      continue;
    }
    const domSource = await readDomSource(page, draft.elementPath);
    if (domSource === null) {
      enriched.push(draft);
      continue;
    }
    enriched.push({
      ...draft,
      evidence: {
        ...draft.evidence,
        extra: {
          ...draft.evidence.extra,
          sourceFile: domSource.sourceFile,
          sourceLine: domSource.sourceLine,
        },
      },
    });
  }
  return enriched;
}
