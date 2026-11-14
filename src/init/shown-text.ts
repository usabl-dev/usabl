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
