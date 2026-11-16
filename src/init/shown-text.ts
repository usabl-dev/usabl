/**
 * Text from the repository as `usabl init` and `usabl init --docs` print it.
 *
 * A path, a route, an include target, a file or folder name, a package name, and a topic name all
 * come from files in the repository, so each can hold a terminal control sequence. Each control
 * character is labelled with its code point, so nothing raw reaches the terminal and a name that
 * holds a control sequence never reads as a clean name. The rest of the scrubbing and the length
 * cap of the operator text helper still apply.
 */
import { operatorPath, operatorText } from '../intake/config-error.js';

export function shownText(value: string): string {
  return operatorText(operatorPath(value));
}

/**
 * The error that stopped `usabl init` or `usabl init --docs`, as the CLI prints it. A file read
 * that fails for a reason init does not handle, such as a name too long for the file system or a
 * link to itself, throws an error whose message holds the path, and the path comes from the
 * repository. Each line keeps its break, so a refusal of several lines reads as written, and each
 * control character in a line is labelled.
 */
export function shownError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split('\n')
    .map((line) => operatorPath(line))
    .join('\n');
}
