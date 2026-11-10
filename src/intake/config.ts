/**
 * Parse operator usabl.config.json into UsablConfig.
 * This unit validates shape only.
 * It must never mint a verdict or choose scan targets on its own.
 */
import type {
  BrowserSandboxPolicy,
  DequeEngineConfig,
  EnginesConfig,
  EvincedEngineConfig,
  JudgeConfig,
  ReachedWhenSignal,
  SurfaceConfig,
  UsablConfig,
} from '../contracts/index.js';
import { assertSurfaceIds } from './surface-ids.js';
import { configError } from './config-error.js';
import { braceRangeIn, expandBraces, UNSUPPORTED_GLOB_CHARACTERS } from '../primitives/match-glob.js';
import { parseNoiseBudgetConfig } from '../output/noise-budget.js';
import { carriesUserinfo } from '../primitives/url-userinfo.js';

function expectObject(value: unknown, label: string): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configError`${label} must be an object`;
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw configError`${label} must be a string`;
  }
  return value;
}

function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw configError`${label} must be a string array`;
  }
  return value;
}

// matchGlob supports `*`, `**`, and `{a,b}` brace groups only. File discovery uses Node's
// glob, which supports more. A glob usabl cannot match the same way discovery does would
// select files at discovery and then drop them at enforcement, a silent mismatch that can
// pass a run that should gate. Refuse such a glob here, at config load, before any run
// launches. UNSUPPORTED_GLOB_CHARACTERS lists the characters matchGlob cannot faithfully evaluate
// after braces.
function checkGlobSupported(pattern: string, label: string): void {
  for (const char of UNSUPPORTED_GLOB_CHARACTERS) {
    if (pattern.includes(char)) {
      throw configError`${label} pattern "${pattern}" uses unsupported glob character "${char}". usabl globs support only *, **, and {a,b} brace groups.`;
    }
  }
  // A nested or unbalanced brace cannot be expanded, so matchGlob would treat the braces
  // as literal text while discovery would not. Refuse it for the same reason.
  if (pattern.includes('{') && expandBraces(pattern) === null) {
    throw configError`${label} pattern "${pattern}" uses an unsupported brace form. usabl globs support only *, **, and single-level {a,b} brace groups.`;
  }
  // Node's glob expands a brace range such as {1..3}, and matchGlob reads it as text, so the two
  // would select different files. Refuse it and ask for the alternatives with commas.
  const range = braceRangeIn(pattern);
  if (range !== null) {
    throw configError`${label} pattern "${pattern}" uses the brace range ${range}, which usabl cannot match. List the alternatives with commas instead, such as {1,2,3}.`;
  }
}

function expectGlobArray(value: unknown, label: string): string[] {
  const patterns = expectStringArray(value, label);
  for (const pattern of patterns) {
    checkGlobSupported(pattern, label);
  }
  return patterns;
}

// A guarded entry with white space at the start or end names a path no file has, so it would
// guard nothing, in CI and locally. The entry is shown in quotes so the space can be seen.
function expectGuardedPaths(value: unknown): string[] {
  const entries = expectGlobArray(value, 'guardedPaths');
  for (const entry of entries) {
    if (entry.trim() !== entry) {
      throw configError`guardedPaths entry "${entry}" starts or ends with white space, so it names no file and would guard nothing. Remove the white space.`;
    }
    checkGuardedPathForm(entry);
  }
  return entries;
}

// One expansion of an entry's brace groups, as segments. A segment is marked when a brace
// alternative wrote any of its characters. The entry's braces are already known to be well formed.
function bracedSegments(entry: string): Array<Array<{ text: string; braced: boolean }>> {
  type Marked = Array<{ char: string; braced: boolean }>;
  let expansions: Marked[] = [[]];
  let i = 0;
  while (i < entry.length) {
    const char = entry.charAt(i);
    const close = char === '{' ? entry.indexOf('}', i) : -1;
    const body = close === -1 ? '' : entry.slice(i + 1, close);
    if (body.includes(',')) {
      const alternatives = body.split(',').map((alternative) => [...alternative].map((c) => ({ char: c, braced: true })));
      expansions = expansions.flatMap((prefix) => alternatives.map((alternative) => [...prefix, ...alternative]));
      i = close + 1;
      continue;
    }
    expansions = expansions.map((prefix) => [...prefix, { char, braced: false }]);
    i++;
  }
  return expansions.map((expansion) => {
    let current = { text: '', braced: false };
    const segments = [current];
    for (const { char, braced } of expansion) {
      if (char === '/') {
        current = { text: '', braced: false };
        segments.push(current);
      } else {
        current.text += char;
        current.braced ||= braced;
      }
    }
    return segments;
  });
}

// The guard can read some entry forms only as a wider folder or as the whole tree, which guards
// more than the entry means. Refuse them here so a new config never holds one, and say how to
// write the entry. A `.` segment, a repeated `/`, and a `..` before any wildcard that stays in the
// repository still load: the guard reads them in canonical form, as it always has.
function checkGuardedPathForm(entry: string): void {
  if (entry.startsWith('/')) {
    const fixed = entry.replace(/^\/+/, '') || '.';
    throw configError`guardedPaths entry "${entry}" starts with /, so it names no path from the repository root. Write it as a path from the repository root without the leading slash: "${fixed}".`;
  }
  for (const segments of bracedSegments(entry)) {
    if (segments.length > 1 && segments[0]?.text === '' && entry.charAt(0) === '{') {
      throw configError`guardedPaths entry "${entry}" has a brace alternative that starts the path with /, so it names no path from the repository root. Write each alternative as a path from the repository root.`;
    }
    let depth = 0;
    let afterWildcard = false;
    for (const segment of segments) {
      if ((segment.text === '.' || segment.text === '..') && segment.braced) {
        throw configError`guardedPaths entry "${entry}" has a . or .. segment inside a brace alternative, so it can name a path outside the folder it starts with. Write each alternative without . or .. segments, as a path from the repository root.`;
      }
      if (segment.text === '' || segment.text === '.') {
        continue;
      }
      if (segment.text === '..') {
        if (afterWildcard) {
          throw configError`guardedPaths entry "${entry}" has a .. after a wildcard, so it can name a path anywhere in the repository. Write it without .. segments, as a path from the repository root.`;
        }
        if (depth === 0) {
          throw configError`guardedPaths entry "${entry}" has a .. segment that leaves the repository root, so it names no path in the repository. Write it as a path from the repository root without .. segments.`;
        }
        depth--;
        continue;
      }
      depth++;
      afterWildcard ||= segment.braced || /[*{]/.test(segment.text);
    }
  }
}

// A budget of zero, a negative, a fraction, or a string would either fail every screen or fail
// deep inside a browser call. Refusing it here keeps the failure at config load, before a run
// launches anything.
function expectPositiveWholeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw configError`${label} must be a positive whole number of milliseconds`;
  }
  return value;
}

// The longest signal cap usabl accepts, ten minutes. A screen that needs longer than that to show
// its own content is not one a gate can wait on, and a value past it is almost always a typo.
export const MAX_SIGNAL_TIMEOUT_MS = 600_000;

/**
 * The signal cap, refused unless it is a safe positive whole number no larger than ten minutes.
 * A safe integer, because JSON reads 1e100 as a number that passes Number.isInteger, and a cap that
 * large would wait forever inside readyTimeoutMs. The refusal names the field and the limit and
 * never echoes the value. Exported so tests can pass NaN and Infinity, which JSON cannot carry.
 */
export function parseSignalTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_SIGNAL_TIMEOUT_MS) {
    throw configError`signalTimeoutMs must be a positive whole number of milliseconds, at most ${String(MAX_SIGNAL_TIMEOUT_MS)}`;
  }
  return value;
}

// The readiness signal a surface declares: positive evidence that the screen really rendered. Two
// shapes are accepted. A string is a CSS selector on its own, which is the shape every earlier
// config uses. An object names a selector, a response path, or both, and every part it names has to
// hold for the screen to count as seen.
//
// An empty selector would match nothing and mark every scan of the surface unseen, which is a
// silent failure hiding as coverage loss. Refuse it at config load so the operator fixes it before
// a run.
//
// What the selector should name cannot be checked here, and it matters. A signal that holds is
// read as the operator asserting this screen rendered, and it overrides the password-field rule
// that would otherwise flag a sign-in page. It is policy, not proof: a selector aimed at a
// persistent application shell, a header, a navigation, or a footer is present on a login wall
// too, so it would pass the wrong page. The refusal message says so, because config load is the
// last place an operator reads anything about this field.
//
// The advice is written into each message rather than interpolated, because configError caps
// every interpolated value at a short length and would cut it off.
const REACHED_WHEN_KEYS = new Set(['selector', 'response']);

function parseSelector(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw configError`${label} must be a non-empty CSS selector naming content only this screen has, such as its own table or heading. A shell, header, navigation, or footer selector matches a sign-in page too and would let a wrong page pass as this screen.`;
  }
  return raw;
}

// The response part is a path on the application, matched against the page's own data requests to
// the appBaseUrl host. It is refused unless it is a plain absolute path, because every other shape
// either cannot match what the matcher compares or matches far too much:
//
//   - a full URL or a "//host" address names a host, and the host is always the application's;
//   - a query or a fragment is never compared, so writing one would read as a filter that is not
//     applied;
//   - whitespace and control characters cannot appear in a request path as sent, and URL parsing
//     strips a trailing control character;
//   - a backslash is read as a slash by URL parsing, and a "." or ".." segment, plain or
//     percent-encoded, is resolved away by it, so the path compared is not the path written;
//   - "/" alone, or anything that parses to it, is answered by every data request on the host,
//     including a sign-in wall's own, so it proves nothing about this screen.
//
// The message never repeats the value, because a value that parses differently from how it reads
// is exactly what an operator cannot judge from a quote of it.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

function isPlainResponsePath(raw: string): boolean {
  if (
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    raw.includes('?') ||
    raw.includes('#') ||
    raw.includes('\\') ||
    /\s/.test(raw) ||
    /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    return false;
  }
  if (raw.split('/').some((segment) => DOT_SEGMENT.test(segment))) {
    return false;
  }
  try {
    return new URL(raw, 'http://usabl.invalid').pathname !== '/';
  } catch {
    return false;
  }
}

function parseResponsePath(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !isPlainResponsePath(raw)) {
    throw configError`${label} must be a path on the application that only this screen requests, such as "/api/users". It starts with one slash, is not the root, and has no host, query, fragment, spaces, control characters, backslashes, or dot segments.`;
  }
  return raw;
}

function parseReachedWhen(raw: unknown, index: number): string | ReachedWhenSignal | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const label = `surfaces[${index}].reachedWhen`;
  if (typeof raw === 'string') {
    return parseSelector(raw, label);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw configError`${label} must be a CSS selector string, or an object with a selector, a response, or both`;
  }
  // A misspelled key would drop that part of the signal without a word, and the screen would be
  // judged on less evidence than the operator wrote down. Refuse it.
  for (const key of Object.keys(raw)) {
    if (!REACHED_WHEN_KEYS.has(key)) {
      throw configError`${label} has an unknown key "${key}". The keys it accepts are selector and response.`;
    }
  }
  const selectorRaw = Reflect.get(raw, 'selector');
  const responseRaw = Reflect.get(raw, 'response');
  if (selectorRaw === undefined && responseRaw === undefined) {
    throw configError`${label} must declare a selector, a response, or both`;
  }
  return {
    ...(selectorRaw === undefined ? {} : { selector: parseSelector(selectorRaw, `${label}.selector`) }),
    ...(responseRaw === undefined ? {} : { response: parseResponsePath(responseRaw, `${label}.response`) }),
  };
}

// A configured URL is carried as written in the Result. A gap ref, a screen url, and an affected
// url all carry it, and the overlay and the stop hook print it, so a credential written into one
// reaches their readers. The url is not rewritten to remove one, because the overlay matches a gap
// to its screen by comparing the exact url, and a rewritten url would orphan the gap. It is
// refused instead, and the message names the field and never the value.
//
// Userinfo is found by the one shared reading in src/primitives/url-userinfo.ts, the same one the
// docs manifest uses for docsBaseUrl.
function parseConfiguredUrl(raw: unknown, label: string): string {
  const value = expectString(raw, label);
  if (carriesUserinfo(value)) {
    throw configError`${label} has a user name or password in it. usabl prints this URL as written in the dev-server overlay and the stop hook, so it refuses a URL with credentials. Remove them, and reach a protected screen with a storage state (USABL_STORAGE_STATE) instead.`;
  }
  return value;
}

/**
 * Warnings about configured URLs that load but may publish something they should not.
 *
 * A query string or a fragment is accepted, because applications select screens by both, and the
 * url is kept as written so the overlay can match gaps to screens. The CLI output, the JSON Result,
 * and the pull request comment drop both, but the overlay and the stop hook print the url as
 * written, so a token or a session value in it still reaches their readers. Each warning names
 * the field and never the value. Text only: this never refuses a config and never decides a verdict.
 */
export function configUrlWarnings(config: UsablConfig): string[] {
  return configUrlWarningsByUrl(config).map(({ warning }) => warning);
}

/**
 * The same warnings, each with the url it is about, so a caller that loads the config many times,
 * such as a dev server on every save, can say each one once. The url is for that comparison only
 * and must never be printed.
 */
export function configUrlWarningsByUrl(config: UsablConfig): Array<{ url: string; warning: string }> {
  const fields: Array<{ label: string; url: string }> = [
    { label: 'appBaseUrl', url: config.appBaseUrl },
    ...config.surfaces.map((surface, index) => ({ label: `surfaces[${index}].url`, url: surface.url })),
  ];
  return fields
    .filter(({ url }) => url.includes('?') || url.includes('#'))
    .map(({ label, url }) => ({
      url,
      warning: `usabl: warning: ${label} has a query string or a fragment. usabl drops the query and the fragment from its CLI output, its JSON Result, pull request comments, and usabl docs reports, but the dev-server overlay and the stop hook print this URL as written, so anything in them still reaches those readers. If it carries a token or a session value, remove it and reach the screen with a storage state (USABL_STORAGE_STATE) instead.`,
    }));
}

// A surface id and a discovered route screen id are one namespace. This declaration is how an
// operator says the two name the same screen, so the planner never has to guess. Only a boolean is
// accepted: a string naming the route would be a second copy of the surface's own id, since the
// planner matches an override by id, and two copies of one fact can disagree.
function parseOverridesDiscoveredRoute(raw: unknown, index: number): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'boolean') {
    throw configError`surfaces[${index}].overridesDiscoveredRoute must be true or false`;
  }
  return raw;
}

function parseSurface(raw: unknown, index: number): SurfaceConfig {
  const surface = expectObject(raw, `surfaces[${index}]`);
  const reachedWhen = parseReachedWhen(Reflect.get(surface, 'reachedWhen'), index);
  const overridesDiscoveredRoute = parseOverridesDiscoveredRoute(
    Reflect.get(surface, 'overridesDiscoveredRoute'),
    index,
  );
  return {
    id: expectString(Reflect.get(surface, 'id'), `surfaces[${index}].id`),
    url: parseConfiguredUrl(Reflect.get(surface, 'url'), `surfaces[${index}].url`),
    files: expectStringArray(Reflect.get(surface, 'files'), `surfaces[${index}].files`),
    ...(reachedWhen === undefined ? {} : { reachedWhen }),
    ...(overridesDiscoveredRoute === undefined ? {} : { overridesDiscoveredRoute }),
  };
}

// A value other than the two the engine knows would otherwise be read as the default, and a typo
// such as "required" would scan without the sandbox the operator asked for. So it is refused,
// naming the field, before a run opens a browser.
function parseBrowserSandbox(value: unknown): BrowserSandboxPolicy {
  if (value !== 'auto' && value !== 'require') {
    throw configError`browserSandbox must be "auto" or "require". "auto" scans without Chromium's sandbox when the system cannot start it and says so; "require" refuses to scan then.`;
  }
  return value;
}

// The origins the judge's isolated browser may reach besides the app origin. A bare origin only:
// a path would read as a narrower allowance than the browser enforces, which works by origin.
function parseJudge(raw: unknown): JudgeConfig {
  const judge = expectObject(raw, 'judge');
  for (const key of Object.keys(judge)) {
    if (key !== 'allowOrigins') {
      throw configError`judge has an unknown key "${key}". The key it accepts is allowOrigins.`;
    }
  }
  const allowOrigins = expectStringArray(Reflect.get(judge, 'allowOrigins'), 'judge.allowOrigins');
  for (const entry of allowOrigins) {
    let origin: string | null = null;
    try {
      const url = new URL(entry);
      origin = url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
    } catch {
      origin = null;
    }
    if (origin === null || (entry !== origin && entry !== `${origin}/`)) {
      throw configError`judge.allowOrigins entry "${entry}" must be a bare http or https origin such as https://fonts.example.com`;
    }
  }
  return { allowOrigins };
}

// The engines block turns on vendor code that can hold credentials and reach the network, so a key
// usabl does not know is refused rather than ignored. A misspelled "enabeld" would otherwise read as
// an engine that is off, and a misspelled "trackUsage" would leave the operator's choice unapplied.
function rejectUnknownEngineKeys(value: object, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    // A promote list is the one key an operator may expect from the engine design. Vendor findings
    // stay preview until a live run on a licensed SDK shows which types repeat, so it gets its own
    // message rather than reading as a typo.
    if (key === 'promote') {
      throw configError`${label}.promote is not accepted yet. Vendor findings stay preview (shown, never blocking) until a live run on a licensed SDK proves which rule types are stable. Remove the key.`;
    }
    if (!allowed.includes(key)) {
      throw configError`${label} has an unknown key "${key}". The keys it accepts are ${allowed.join(', ')}.`;
    }
  }
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw configError`${label} must be true or false`;
  }
  return value;
}

function parseDequeEngine(raw: unknown): DequeEngineConfig {
  const engine = expectObject(raw, 'engines.deque');
  rejectUnknownEngineKeys(engine, ['enabled', 'rulesetId', 'trackUsage'], 'engines.deque');
  const rulesetRaw = Reflect.get(engine, 'rulesetId');
  const trackUsageRaw = Reflect.get(engine, 'trackUsage');
  if (rulesetRaw !== undefined && (typeof rulesetRaw !== 'string' || rulesetRaw.trim().length === 0)) {
    throw configError`engines.deque.rulesetId must be a non-empty string`;
  }
  return {
    enabled: expectBoolean(Reflect.get(engine, 'enabled'), 'engines.deque.enabled'),
    ...(rulesetRaw === undefined ? {} : { rulesetId: rulesetRaw }),
    ...(trackUsageRaw === undefined
      ? {}
      : { trackUsage: expectBoolean(trackUsageRaw, 'engines.deque.trackUsage') }),
  };
}

function parseEvincedEngine(raw: unknown): EvincedEngineConfig {
  const engine = expectObject(raw, 'engines.evinced');
  rejectUnknownEngineKeys(engine, ['enabled', 'mode'], 'engines.evinced');
  const modeRaw = Reflect.get(engine, 'mode');
  if (modeRaw !== undefined && modeRaw !== 'offline' && modeRaw !== 'online') {
    throw configError`engines.evinced.mode must be "offline" or "online"`;
  }
  return {
    enabled: expectBoolean(Reflect.get(engine, 'enabled'), 'engines.evinced.enabled'),
    ...(modeRaw === undefined ? {} : { mode: modeRaw }),
  };
}

function parseEngines(raw: unknown): EnginesConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const engines = expectObject(raw, 'engines');
  rejectUnknownEngineKeys(engines, ['deque', 'evinced'], 'engines');
  const dequeRaw = Reflect.get(engines, 'deque');
  const evincedRaw = Reflect.get(engines, 'evinced');
  return {
    ...(dequeRaw === undefined ? {} : { deque: parseDequeEngine(dequeRaw) }),
    ...(evincedRaw === undefined ? {} : { evinced: parseEvincedEngine(evincedRaw) }),
  };
}

export function parseUsablConfig(raw: string): UsablConfig {
  // A JSON.parse failure message quotes the offending input back, so it is operator text on the
  // same egress as every other message here and cannot be allowed to pass through unscrubbed.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw configError`usabl.config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  const root = expectObject(parsed, 'config');
  const discovery = expectObject(Reflect.get(root, 'discovery'), 'discovery');
  const surfacesRaw = Reflect.get(root, 'surfaces');
  if (!Array.isArray(surfacesRaw)) {
    throw configError`surfaces must be an array`;
  }

  const surfaces = surfacesRaw.map((surface, index) => parseSurface(surface, index));
  // Shape is checked per entry above. Identity is a property of the whole list, so it is
  // checked once the list exists.
  assertSurfaceIds(surfaces);

  const requirementsRaw = Reflect.get(root, 'requirements');
  const requirements =
    requirementsRaw === undefined ? undefined : expectString(requirementsRaw, 'requirements');

  const promotedRaw = Reflect.get(root, 'promotedObligations');
  const promotedObligations =
    promotedRaw === undefined ? undefined : expectStringArray(promotedRaw, 'promotedObligations');

  const readyTimeoutRaw = Reflect.get(root, 'readyTimeoutMs');
  const readyTimeoutMs =
    readyTimeoutRaw === undefined
      ? undefined
      : expectPositiveWholeNumber(readyTimeoutRaw, 'readyTimeoutMs');

  const signalTimeoutRaw = Reflect.get(root, 'signalTimeoutMs');
  const signalTimeoutMs =
    signalTimeoutRaw === undefined
      ? undefined
      : parseSignalTimeoutMs(signalTimeoutRaw);

  const noiseBudgetRaw = Reflect.get(root, 'noiseBudget');
  const noiseBudget =
    noiseBudgetRaw === undefined ? undefined : parseNoiseBudgetConfig(noiseBudgetRaw);

  const browserSandboxRaw = Reflect.get(root, 'browserSandbox');
  const browserSandbox =
    browserSandboxRaw === undefined ? undefined : parseBrowserSandbox(browserSandboxRaw);

  const judgeRaw = Reflect.get(root, 'judge');
  const judge = judgeRaw === undefined ? undefined : parseJudge(judgeRaw);
  const engines = parseEngines(Reflect.get(root, 'engines'));

  return {
    appBaseUrl: parseConfiguredUrl(Reflect.get(root, 'appBaseUrl'), 'appBaseUrl'),
    uiFileGlobs: expectGlobArray(Reflect.get(root, 'uiFileGlobs'), 'uiFileGlobs'),
    discovery: {
      // routerFile is an exact path read with fs.readFile, never matched by matchGlob, so it
      // is not glob-validated. surfaces[].files are compared with exact string equality in the
      // planner, so they are exact paths too and stay plain string arrays.
      routerFile: expectString(Reflect.get(discovery, 'routerFile'), 'discovery.routerFile'),
      wideBlastGlobs: expectGlobArray(Reflect.get(discovery, 'wideBlastGlobs'), 'discovery.wideBlastGlobs'),
    },
    surfaces,
    guardedPaths: expectGuardedPaths(Reflect.get(root, 'guardedPaths')),
    ...(requirements === undefined ? {} : { requirements }),
    ...(promotedObligations === undefined ? {} : { promotedObligations }),
    ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
    ...(signalTimeoutMs === undefined ? {} : { signalTimeoutMs }),
    ...(noiseBudget === undefined ? {} : { noiseBudget }),
    ...(browserSandbox === undefined ? {} : { browserSandbox }),
    ...(judge === undefined ? {} : { judge }),
    ...(engines === undefined ? {} : { engines }),
  };
}
