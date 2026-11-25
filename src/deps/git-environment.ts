/**
 * The environment every git command usabl runs gets. It keeps git's answers to what the repository
 * stores, whatever a local setting asks for, and keeps git's own messages in English.
 */

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
