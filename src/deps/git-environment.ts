/**
 * The environment every git command usabl runs gets. It keeps git's answers to what the repository
 * stores, whatever a local setting asks for, and keeps git's own messages in English.
 */

// Variables that point git at another repository, index, object store, work tree, config, or
// attribute source than the one in the folder usabl runs in. With GIT_DIR and GIT_WORK_TREE set to
// a decoy, every read described the decoy, and a check run that way saved a receipt for files it
// never read. usabl finds the repository from the folder it runs in, so it gives git none of them.
const POINTS_ELSEWHERE: ReadonlySet<string> = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_QUARANTINE_PATH',
  'GIT_SHALLOW_FILE',
  'GIT_NAMESPACE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_ICASE_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
]);

// Every GIT_CONFIG_* variable (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n and
// GIT_CONFIG_VALUE_n, GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM, GIT_CONFIG) and
// every GIT_ATTR_* variable (GIT_ATTR_SOURCE, GIT_ATTR_NOSYSTEM).
const POINTS_ELSEWHERE_PREFIXES = ['GIT_CONFIG', 'GIT_ATTR_'] as const;

/**
 * This process's environment without the variables that point git elsewhere. Callers add their own
 * settings after it, and the fixed settings last.
 */
export function gitProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (POINTS_ELSEWHERE.has(upper) || POINTS_ELSEWHERE_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    env[key] = value;
  }
  return env;
}

/**
 * git reads objects and commit parents as stored, never as a local file rewrites them.
 *
 * GIT_NO_REPLACE_OBJECTS=1: `git replace` makes git read one object as another everywhere, so a
 * replaced HEAD tree that holds a staged edit made git status read clean, and a replaced policy
 * blob read as other text at the trusted ref while its id stayed the same.
 *
 * GIT_GRAFT_FILE=/dev/null: a line in `.git/info/grafts` gives a commit other parents, so a graft
 * that makes HEAD a parent of the trusted commit made `git diff <trusted>...HEAD` list nothing for a
 * committed edit. /dev/null holds no grafts, and git reads it as empty on every platform.
 */
export const STORED_OBJECTS_ENVIRONMENT = {
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_GRAFT_FILE: '/dev/null',
} as const;

/**
 * LC_ALL=C keeps git's error text in English, because usabl tells a missing file from a failure by
 * that text, and git translates it into the user's language. With -z, file names are raw bytes, so
 * the locale does not change how they are listed.
 *
 * GIT_LITERAL_PATHSPECS=1 makes git read every path as its own exact name. Without it, git reads a
 * path that starts with pathspec magic, such as `:(top)x.json` or `:(literal)x.json`, as an
 * instruction, and lists `x.json` instead, so a guarded file with such a name read as absent at
 * every ref. No command passes a pattern as a path.
 *
 * GIT_OPTIONAL_LOCKS=0: a read never writes the user's index.
 */
export const GIT_ENVIRONMENT = {
  LC_ALL: 'C',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  ...STORED_OBJECTS_ENVIRONMENT,
} as const;
