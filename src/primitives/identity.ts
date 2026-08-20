import type { Draft, IdentityBasis } from '../contracts/index.js';
import { slug } from './slug.js';

/** Rules that assert "this element has no accessible name" - never keyable by name. */
export const IDENTITY_WEAK = new Set<string>(['button-name', 'pf-icon-button-name']);

/** Strip volatile positional detail from an elementPath into a stable structural token. */
function neutralizePath(path: string): string {
  return path
    .replace(/:nth-of-type\(\d+\)/g, '')
    .replace(/:nth-child\(\d+\)/g, '')
    .replace(/\s*>\s*/g, '>')
    .replace(/\s+/g, '');
}

/**
 * Layer-independent identity for a Draft. elementKey excludes the layer so dedup can
 * collapse the same defect across axe/pf/walk. Returns null key for count-based rules.
 */
export function computeIdentity(draft: Draft): { elementKey: string | null; identityBasis: IdentityBasis } {
  const base = `${draft.screenId}|${draft.rule}`;
  if (IDENTITY_WEAK.has(draft.rule)) {
    return { elementKey: null, identityBasis: 'count' };
  }
  const name = draft.evidence.name?.value;
  if (name) {
    return { elementKey: `${base}|name:${slug(name)}`, identityBasis: 'name' };
  }
  const role = draft.role ?? 'unknown';
  return { elementKey: `${base}|struct:${role}:${neutralizePath(draft.elementPath)}`, identityBasis: 'structural' };
}
