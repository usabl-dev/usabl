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
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(v as number)) throw new Error('canonicalize: non-finite number');
    return JSON.stringify(v);
  }
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => serialize(x === undefined ? null : x)).join(',') + ']';
  if (t === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k])).join(',') + '}';
  }
  throw new Error('canonicalize: unserializable value of type ' + t);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function canonicalHash(value: unknown): string {
  return sha256(canonicalize(value));
}
