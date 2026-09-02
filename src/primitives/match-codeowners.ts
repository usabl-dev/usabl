/**
 * CODEOWNERS pattern matching for the policy gate.
 * A compiled pattern is the only way to match, so an uninterpretable pattern cannot
 * become a rule that silently owns nothing. Silent no-match is what made the gate
 * unsatisfiable: every rule resolved to zero owners and every approval was refused.
 * This unit is pure and reads no files.
 */

export type CompiledCodeownersPattern =
  | { ok: true; match: (path: string) => boolean }
  | { ok: false; reason: string };

/**
 * Only the gitignore subset the gate can honour exactly. `**`, `!`, `[]`, and `\` change
 * which files an owner covers, and guessing at them would either hand approval rights to
 * the wrong people or drop them from the wrong paths. Refusing is the honest answer.
 */
function unsupported(pattern: string): string | null {
  if (pattern.includes('**')) {
    return 'a ** wildcard is not supported, use a trailing / to own a directory';
  }
  if (pattern.startsWith('!')) {
    return 'a ! negation is not supported';
  }
  if (/[[\]\\]/.test(pattern)) {
    return 'a [ ] character range or a \\ escape is not supported';
  }
  const core = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  if (core.length === 0) {
    return 'the pattern names no path';
  }
  if (core.split('/').some((segment) => segment.length === 0)) {
    return 'the pattern has an empty path segment';
  }
  return null;
}

function segmentToSource(segment: string): string {
  return segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
}

export function compileCodeownersPattern(pattern: string): CompiledCodeownersPattern {
  const reason = unsupported(pattern);
  if (reason !== null) {
    return { ok: false, reason };
  }

  const directoryOnly = pattern.endsWith('/');
  const core = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  // gitignore anchors a pattern that carries a slash anywhere but the end. A slash-free
  // pattern such as `.usabl-evidence.json` or `*` matches at any depth.
  const anchored = pattern.startsWith('/') || core.includes('/');
  const body = core.split('/').map(segmentToSource).join('/');
  const rx = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}$`);

  return {
    ok: true,
    match: (path: string): boolean => {
      // Owning a directory means owning what is under it, so every parent of the path is
      // a candidate. A trailing slash rules out a plain file of the same name.
      if (!directoryOnly && rx.test(path)) {
        return true;
      }
      for (let cut = path.indexOf('/'); cut !== -1; cut = path.indexOf('/', cut + 1)) {
        if (rx.test(path.slice(0, cut))) {
          return true;
        }
      }
      return false;
    },
  };
}
