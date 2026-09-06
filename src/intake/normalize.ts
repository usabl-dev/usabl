/**
 * YAML intake normalizer for requirement bundles.
 * It reads untrusted YAML into plain data, then delegates all shape checks to parseBundle.
 * It must never accept custom constructors, and it must never fail open on parse errors.
 *
 * JSON_SCHEMA is used so custom tags cannot construct surprising runtime types.
 * Any parse failure is surfaced as approval_required for explicit human review.
 */
import { JSON_SCHEMA, load } from 'js-yaml';
import { scrubString } from '../surfaces/scrub.js';
import { parseBundle, type ParseBundleResult } from './schema.js';

function formatYamlFailure(error: unknown): string {
  if (error instanceof Error) {
    // The parser quotes the offending source line in its message. That line is file bytes on
    // their way to a terminal, so it is scrubbed before it becomes a reason.
    return `intake YAML is invalid: ${scrubString(error.message)}`;
  }

  return 'intake YAML is invalid';
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
