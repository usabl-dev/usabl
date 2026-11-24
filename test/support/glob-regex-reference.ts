/**
 * The regular expression glob matchers usabl used before its matcher stopped backtracking, kept
 * word for word so tests can require the new matcher to give the same answers. Tests only. The
 * matchers here can take time that grows very fast with a path's length, so a test calls them
 * only on short paths.
 */
import { expandBraces } from '../../src/primitives/match-glob.js';

function compileToRegExp(pattern: string): RegExp {
  return new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\x00/g, '[\\s\\S]*') +
      '$',
  );
}

const NON_DOT_NAME = '(?!\\.)[^/]+';

function segmentWithoutDotMatch(segment: string): string {
  const body = segment.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*+/g, '[^/]*');
  return segment.startsWith('.') ? body : `(?!\\.)${body}`;
}

function compileWithoutDotMatch(pattern: string): RegExp {
  const segments = pattern.split('/');
  let source = '';
  let slash = false;
  segments.forEach((segment, index) => {
    const separator = slash ? '/' : '';
    if (segment === '**') {
      if (index === segments.length - 1) {
        source += `${separator}${NON_DOT_NAME}(?:/${NON_DOT_NAME})*`;
        slash = true;
      } else {
        source += `${separator}(?:${NON_DOT_NAME}/)*`;
        slash = false;
      }
      return;
    }
    source += separator + segmentWithoutDotMatch(segment);
    slash = true;
  });
  return new RegExp(`^${source}$`);
}

/** The old globMatcher. */
export function regexGlobMatcher(pattern: string, options: { dot?: boolean } = {}): (file: string) => boolean {
  const expansions = pattern.includes('{') ? expandBraces(pattern) : [pattern];
  const patterns = expansions ?? [pattern];
  const compile = options.dot === false ? compileWithoutDotMatch : compileToRegExp;
  const compiled = patterns.map(compile);
  return (file: string): boolean => compiled.some((rx) => rx.test(file));
}

function segmentToSource(segment: string, questionIsWildcard: boolean): string {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return questionIsWildcard ? escaped.replace(/\?/g, '[^/]') : escaped.replace(/\?/g, '\\?');
}

interface Reading {
  atRoot: boolean;
  throughParent: boolean;
  questionIsWildcard: boolean;
}

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

/**
 * The old state of a CODEOWNERS pattern for a path, for a pattern the compiler accepts: 'match'
 * when every reading matches, 'unknown' when some do, and 'none' otherwise.
 */
export function regexCodeownersState(pattern: string): (path: string) => 'match' | 'none' | 'unknown' {
  const directoryOnly = pattern.endsWith('/');
  const core = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  const matchers = readingsOf(pattern, core).map((reading) => regexCodeownersReading(core, directoryOnly, reading));
  return (path) => {
    const results = matchers.map((matcher) => matcher(path));
    if (results.every(Boolean)) {
      return 'match';
    }
    return results.some(Boolean) ? 'unknown' : 'none';
  };
}

/** The old test of one CODEOWNERS reading, for a pattern core with its slashes taken off. */
export function regexCodeownersReading(core: string, directoryOnly: boolean, reading: Reading): (path: string) => boolean {
  const body = core
    .split('/')
    .map((segment) => segmentToSource(segment, reading.questionIsWildcard))
    .join('/');
  const rx = new RegExp(`^${reading.atRoot ? '' : '(?:[\\s\\S]*/)?'}${body}$`);
  return (path) => {
    if (!directoryOnly && rx.test(path)) {
      return true;
    }
    if (!reading.throughParent) {
      return false;
    }
    for (let cut = path.indexOf('/'); cut !== -1; cut = path.indexOf('/', cut + 1)) {
      if (rx.test(path.slice(0, cut))) {
        return true;
      }
    }
    return false;
  };
}
