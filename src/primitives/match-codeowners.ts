/**
 * CODEOWNERS pattern matching for the policy gate.
 * A compiled pattern is the only way to match, so an uninterpretable pattern cannot
 * become a rule that silently owns nothing. Silent no-match is what made the gate
 * unsatisfiable: every rule resolved to zero owners and every approval was refused.
 * This unit is pure and reads no files.
 */

/**
 * Whether a pattern owns a path. `unknown` means the readings of the pattern that GitHub's
 * documentation leaves open disagree for this path, so usabl cannot tell what GitHub does.
 */
export type CodeownersMatch = 'match' | 'none' | 'unknown';

export type CompiledCodeownersPattern =
  | { ok: true; state: (path: string) => CodeownersMatch }
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
  const segments = core.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    return 'the pattern has an empty path segment';
  }
  if (segments.slice(0, -1).some((segment) => /[*?]/.test(segment))) {
    return 'a wildcard before the last path segment is not supported';
  }
  return null;
}

function segmentToSource(segment: string, questionIsWildcard: boolean): string {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return questionIsWildcard ? escaped.replace(/\?/g, '[^/]') : escaped.replace(/\?/g, '\\?');
}

/**
 * One way GitHub may read a pattern. GitHub's documentation fixes some choices and leaves others
 * open, so a pattern can have more than one reading.
 */
interface Reading {
  // The pattern matches at the repository root only, or under any folder.
  atRoot: boolean;
  // The pattern owns what is under a folder it matches.
  throughParent: boolean;
  // `?` matches one character, or stands for itself.
  questionIsWildcard: boolean;
}

/**
 * The readings GitHub's CODEOWNERS documentation leaves open for a pattern:
 * - A leading slash anchors at the root (`/docs/`, `/build/logs/`). A slash-free pattern matches at
 *   any depth (`*.js`, `apps/`). A pattern with an inner slash and no leading slash (`docs/*`) is
 *   shown only for root paths, so both are open.
 * - A trailing slash owns everything under the folder (`apps/`, `/docs/`). A literal last segment
 *   with an inner or leading slash owns what is under it (`/apps/github`). A wildcard in the last
 *   segment does not match through a parent folder (`docs/*` does not match
 *   `docs/build-app/troubleshooting.md`). A slash-free literal with no trailing slash is not shown
 *   for a folder, so both are open, and so is a trailing slash after a wildcard.
 * - `?` is not in the documentation, so both readings are open.
 */
function readingsOf(pattern: string, core: string): Reading[] {
  const leadingSlash = pattern.startsWith('/');
  const trailingSlash = pattern.endsWith('/');
  const innerSlash = core.includes('/');
  const last = core.slice(core.lastIndexOf('/') + 1);
  const wildcardLast = /[*?]/.test(last);

  const atRoot = leadingSlash ? [true] : innerSlash ? [true, false] : [false];
  let throughParent: boolean[];
  if (trailingSlash) {
    throughParent = wildcardLast ? [true, false] : [true];
  } else if (wildcardLast) {
    throughParent = [false];
  } else {
    throughParent = leadingSlash || innerSlash ? [true] : [true, false];
  }
  const question = pattern.includes('?') ? [true, false] : [true];

  const readings: Reading[] = [];
  for (const root of atRoot) {
    for (const parent of throughParent) {
      for (const questionIsWildcard of question) {
        readings.push({ atRoot: root, throughParent: parent, questionIsWildcard });
      }
    }
  }
  return readings;
}

function readingMatcher(core: string, directoryOnly: boolean, reading: Reading): (path: string) => boolean {
  const body = core
    .split('/')
    .map((segment) => segmentToSource(segment, reading.questionIsWildcard))
    .join('/');
  const rx = new RegExp(`^${reading.atRoot ? '' : '(?:[\\s\\S]*/)?'}${body}$`);
  return (path) => {
    // A trailing slash rules out a plain file of the same name.
    if (!directoryOnly && rx.test(path)) {
      return true;
    }
    if (!reading.throughParent) {
      return false;
    }
    // Owning a folder means owning what is under it, so every parent of the path is a candidate.
    for (let cut = path.indexOf('/'); cut !== -1; cut = path.indexOf('/', cut + 1)) {
      if (rx.test(path.slice(0, cut))) {
        return true;
      }
    }
    return false;
  };
}

export function compileCodeownersPattern(pattern: string): CompiledCodeownersPattern {
  const reason = unsupported(pattern);
  if (reason !== null) {
    return { ok: false, reason };
  }

  const directoryOnly = pattern.endsWith('/');
  const core = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  const matchers = readingsOf(pattern, core).map((reading) => readingMatcher(core, directoryOnly, reading));

  return {
    ok: true,
    state: (path: string): CodeownersMatch => {
      const results = matchers.map((matcher) => matcher(path));
      if (results.every(Boolean)) {
        return 'match';
      }
      return results.some(Boolean) ? 'unknown' : 'none';
    },
  };
}
