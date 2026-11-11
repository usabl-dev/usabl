/**
 * The character rules for the design file fields a requirement records: the Figma file key, the
 * node id, and the file version.
 *
 * Each value comes from a design file or from a person who typed a file key, and each one later
 * goes into a URL, a YAML comment, or a report line. So each is held to a narrow set of visible
 * ASCII characters: a key or id with a slash, a space, a line break, or an invisible character is
 * refused, never cleaned up. Figma's own keys, node ids, and versions fit these sets. The messages
 * never repeat the refused value. This unit checks text only and never decides a verdict.
 */

// A Figma file key is letters and digits. The dash and underscore leave room for branch keys.
const FILE_KEY = /^[A-Za-z0-9_-]{1,128}$/u;
// A node id is numbers joined by colons, and an instance id joins several with semicolons.
const NODE_ID = /^[A-Za-z0-9:;_-]{1,256}$/u;
// A file version is a number in Figma's API. Dots and dashes leave room for other forms.
const VERSION = /^[A-Za-z0-9._-]{1,128}$/u;

export function describeFileKeyProblem(key: string): string | null {
  return FILE_KEY.test(key)
    ? null
    : 'must be a Figma file key: 1 to 128 letters, digits, dashes, or underscores, as in the file URL after /file/ or /design/';
}

export function describeNodeIdProblem(id: string): string | null {
  return NODE_ID.test(id)
    ? null
    : 'must be a Figma node id: 1 to 256 letters, digits, colons, semicolons, dashes, or underscores, such as 12:34';
}

export function describeVersionProblem(version: string): string | null {
  return VERSION.test(version)
    ? null
    : 'must be a Figma file version: 1 to 128 letters, digits, dots, dashes, or underscores';
}
