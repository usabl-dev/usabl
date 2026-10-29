/**
 * Chromium's sandbox for the scan browser: how to tell a launch that failed because the system
 * cannot provide the sandbox from a launch that failed for any other reason, and the refusal a run
 * gets when it requires the sandbox.
 *
 * The sandbox is what contains a page that exploits a bug in Chromium's renderer. Without it such
 * a page runs with the rights of the user running usabl. Whether it was on never changes a verdict.
 */

import type { BrowserSandboxPolicy } from '../contracts/index.js';

export type { BrowserSandboxPolicy };

// Text that appears in a launch error only when Chromium could not start its sandbox. Each is a
// line Chromium writes, or the heading Playwright puts over those lines, and none is a word that
// shows up in other launch failures. A launch argument list can name --no-sandbox, so that flag on
// its own is never matched. A failure whose text matches none of these is not a sandbox failure:
// a missing Chromium, a missing library, or a crash has nothing to gain from a second launch
// without the sandbox, and reporting it as a sandbox problem would send the operator the wrong way.
const SANDBOX_FAILURE_MARKERS = [
  // Playwright's heading over the three lines below that it recognizes.
  'Chromium sandboxing failed!',
  // No user namespace sandbox and no setuid helper. Ubuntu 23.10 and later restrict user
  // namespaces through AppArmor, which ends here.
  'No usable sandbox!',
  // Chromium refuses to run as root with its sandbox on, which is common in containers.
  'Running as root without --no-sandbox is not supported',
  'crbug.com/638180',
  // A sandbox failure Playwright also recognizes by its bug link.
  'crbug.com/357670',
  // The older setuid helper is missing or has the wrong owner or mode.
  'The SUID sandbox helper binary',
  // The setuid helper could not create its namespaces, as in a container that forbids them.
  'Failed to move to new namespace',
];

/** Whether a launch error says Chromium could not start its sandbox. Unknown text says no. */
export function isSandboxLaunchFailure(message: string): boolean {
  return SANDBOX_FAILURE_MARKERS.some((marker) => message.includes(marker));
}

// How to give Chromium its sandbox back, for the refusal and the doctor finding. Ubuntu's fix is
// an AppArmor profile for the Chromium binary, which Chromium documents. A container needs a user
// other than root and permission to create user namespaces.
export const SANDBOX_FIX =
  'To enable it on Ubuntu 23.10 or later, give Chromium an AppArmor profile that allows unprivileged ' +
  'user namespaces, as described at ' +
  'https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md. ' +
  'In a container, run usabl as a user other than root, and allow the container to create user ' +
  'namespaces, for example with a seccomp profile that permits them.';

/**
 * The refusal a run gets when it requires the sandbox and Chromium could not start it. The check
 * runner lets this through instead of turning it into a coverage gap, so the run ends with no
 * verdict and exit 4, which CI treats as a failure.
 *
 * The message becomes the run summary, which the terminal shows up to 400 characters, so it is
 * kept short enough to arrive whole. The doctor finding carries the longer fix and the link.
 */
export class BrowserSandboxRequiredError extends Error {
  constructor() {
    super(
      'usabl did not scan: Chromium could not start its sandbox on this system, and usabl.config.json ' +
        'sets browserSandbox to "require". To enable the sandbox, let Chromium create user namespaces: ' +
        'on Ubuntu 23.10 or later with an AppArmor profile for it, in a container as a user other than ' +
        'root with a seccomp profile that permits them. Run "usabl doctor" for details.',
    );
    this.name = 'BrowserSandboxRequiredError';
  }
}

export function isBrowserSandboxRefusal(error: unknown): error is BrowserSandboxRequiredError {
  return error instanceof BrowserSandboxRequiredError;
}
