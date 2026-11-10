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

/**
 * A CODEOWNERS line with its comment removed. A `#` at the start of the line or after whitespace
 * starts a comment, as GitHub documents. A `#` inside a token, such as `/src/file#1.ts`, is not
 * documented: GitHub may read it as part of the pattern. Then usabl cannot tell which rule matches
 * a path last, so this returns the token that holds it and the caller refuses the whole file.
 */
export function stripCodeownersComment(line: string): { ok: true; text: string } | { ok: false; token: string } {
  for (let index = 0; index < line.length; index += 1) {
    if (line.charAt(index) !== '#') {
      continue;
    }
    if (index === 0 || /\s/.test(line.charAt(index - 1))) {
      return { ok: true, text: line.slice(0, index) };
    }
    const start = line.slice(0, index).search(/\S+$/);
    const end = line.slice(index).search(/\s/);
    return { ok: false, token: line.slice(start, end === -1 ? line.length : index + end) };
  }
  return { ok: true, text: line };
}

/** One CODEOWNERS line: nothing, a rule, or a line that refuses the whole file. */
export type CodeownersLine =
  | { kind: 'blank' }
  | { kind: 'rule'; pattern: string; owners: string[] }
  | { kind: 'refused'; message: string };

/**
 * The one line reader for CODEOWNERS, used by the policy check and by doctor, so both read the
 * same rules. It strips the comment, refuses a `#` inside a token, and splits the pattern from
 * the owners.
 */
export function readCodeownersLine(line: string): CodeownersLine {
  const content = stripCodeownersComment(line);
  if (!content.ok) {
    return {
      kind: 'refused',
      message: `CODEOWNERS token ${content.token} holds a # that does not follow a space, so usabl cannot tell whether GitHub reads it as part of the pattern or as a comment`,
    };
  }
  const trimmed = content.text.trim();
  if (trimmed.length === 0) {
    return { kind: 'blank' };
  }
  const [pattern = '', ...owners] = trimmed.split(/\s+/);
  return { kind: 'rule', pattern, owners };
}

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
 *   segment of a pattern with a slash does not match through a parent folder (`docs/*` does not
 *   match `docs/build-app/troubleshooting.md`). A slash-free pattern with no trailing slash, a
 *   literal such as `gate` or a wildcard such as `*.js`, is not shown for a folder whose name it
 *   matches, so both are open there, and so is a trailing slash after a wildcard.
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
    // docs/* shows a pattern with a slash. A slash-free one such as *.js is not shown for a folder
    // whose name it matches, so both readings are open there.
    throughParent = leadingSlash || innerSlash ? [false] : [true, false];
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
