/**
 * YAML intake normalizer for requirement bundles.
 * It reads untrusted YAML into plain data, then delegates all shape checks to parseBundle.
 * It must never accept custom constructors, and it must never fail open on parse errors.
 *
 * JSON_SCHEMA is used so custom tags cannot construct surprising runtime types.
 * Any parse failure is surfaced as approval_required for explicit human review.
 */
import { JSON_SCHEMA, load, YAMLException } from 'js-yaml';
import { parseBundle, type ParseBundleResult } from './schema.js';

// The words of a parser problem, up to the first character that can open source text. Some
// problems carry source text after a fixed lead, such as 'unidentified alias "name"' or
// 'unknown tag !<name>'. Only the fixed lead is kept.
const PROBLEM_LEAD = /^[A-Za-z0-9 ,;()-]+/;

/**
 * The reason a YAML parse failed: where it failed and what the parser found, with no source text.
 *
 * The parser's own message quotes the offending source line with a pointer under it. That line is
 * file bytes, and pattern redaction is the only thing that would stand between it and a terminal,
 * so the message is never used. The line number comes from the parser's position mark, and the
 * problem from its fixed wording, cut before anything it took from the file.
 */
function formatYamlFailure(error: unknown): string {
  if (!(error instanceof YAMLException)) {
    return 'intake YAML is invalid';
  }

  const line = Number.isInteger(error.mark?.line) ? error.mark.line + 1 : null;
  const problem = (PROBLEM_LEAD.exec(error.reason ?? '')?.[0] ?? '').replace(/[ ,;(-]+$/, '').trim();
  const where = line === null ? '' : ` at line ${line}`;
  const what = problem.length > 0 ? problem : 'the parser refused it';
  return `intake YAML is invalid${where}: ${what}`;
}

export function normalize(raw: string): ParseBundleResult {
  try {
    const parsedYaml = load(raw, { schema: JSON_SCHEMA });
    return parseBundle(parsedYaml);
  } catch (error: unknown) {
    return {
      ok: false,
      verdict: 'approval_required',
      reason: formatYamlFailure(error),
    };
  }
}
