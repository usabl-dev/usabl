import { createHash } from 'node:crypto';

/**
 * RFC 8785 (JCS)-style canonical JSON: object keys sorted by UTF-16 code unit,
 * no insignificant whitespace, undefined-valued keys dropped (as JSON does).
 * Restricted to JSON-safe values (no floats needing special formatting appear in
 * Result); non-finite numbers are rejected rather than silently coerced.
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalize: non-finite number');
    return JSON.stringify(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map((x) => serialize(x === undefined ? null : x)).join(',') + ']';
  }
  if (typeof v === 'object') {
    // `object` has no index signature; this is the JSON object case after null/array.
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k])).join(',') + '}';
  }
  throw new Error('canonicalize: unserializable value of type ' + typeof v);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function canonicalHash(value: unknown): string {
  return sha256(canonicalize(value));
}
