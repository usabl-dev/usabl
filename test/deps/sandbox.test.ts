import { describe, expect, it } from 'vitest';
import { isSandboxLaunchFailure } from '../../src/deps/sandbox.js';

// What a launch failure looks like when Chromium cannot start its sandbox. The first is the whole
// error Playwright threw on a Fedora host when Chromium ran as root inside a user namespace, with
// the process id and the long argument list cut. The rest are the lines Chromium itself writes for
// the other ways its sandbox fails to start, as its own binary carries them.
const SANDBOX_FAILURES: Array<[string, string]> = [
  [
    'Playwright, running as root',
    [
      'browserType.launch: Target page, context or browser has been closed',
      'Browser logs:',
      'Chromium sandboxing failed!',
      '================================',
      'To avoid the sandboxing issue, do either of the following:',
      '  - (preferred): Configure your environment to support sandboxing',
      "  - (alternative): Launch Chromium without sandbox using 'chromiumSandbox: false' option",
      '================================',
      '',
      'Call log:',
      '  - <launching> /home/user/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell --headless --remote-debugging-pipe',
      '  - <launched> pid=1000',
      '  - [pid=1000][err] [1028/193523.917698:ERROR:content/browser/zygote_host/zygote_host_impl_linux.cc:101] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.',
      '  - [pid=1000] <process did exit: exitCode=1, signal=null>',
    ].join('\n'),
  ],
  [
    'no usable sandbox, current wording',
    '[FATAL:zygote_host_impl_linux.cc(132)] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md. Otherwise see https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md for more information on developing with the (older) SUID sandbox. If you want to live dangerously and need an immediate workaround, you can try using --no-sandbox.',
  ],
  [
    'no usable sandbox, older wording',
    '[FATAL:zygote_host_impl_linux.cc(117)] No usable sandbox! Update your kernel or see https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md for more information on developing with the SUID sandbox. If you want to live dangerously and need an immediate workaround, you can try using --no-sandbox.',
  ],
  [
    'a setuid sandbox helper with the wrong owner or mode',
    "[FATAL:setuid_sandbox_host.cc(158)] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that /opt/chrome/chrome-sandbox is owned by root and has mode 4755.",
  ],
  [
    'a missing setuid sandbox helper',
    '[FATAL:setuid_sandbox_host.cc(141)] The SUID sandbox helper binary is missing: /opt/chrome/chrome-sandbox Aborting now.',
  ],
  [
    'a container that refuses new namespaces',
    'Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted',
  ],
];

// Launch failures that have nothing to do with the sandbox. A fallback on any of these would
// launch a second browser without the sandbox for no reason, and report a sandbox problem that
// is not there.
const OTHER_FAILURES: Array<[string, string]> = [
  [
    'Chromium is not installed',
    [
      "browserType.launch: Executable doesn't exist at /home/user/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
      'Looks like Playwright Test or Playwright was just installed or updated.',
      'Please run the following command to download new browsers:',
      '    npx playwright install',
    ].join('\n'),
  ],
  [
    'a missing system library',
    'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n[pid=1000][err] chrome-headless-shell: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory',
  ],
  [
    'a crash at start',
    'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n[pid=1000][err] Received signal 11 SEGV_MAPERR 000000000000\n[pid=1000] <process did exit: exitCode=null, signal=SIGSEGV>',
  ],
  ['a launch timeout', 'browserType.launch: Timeout 180000ms exceeded.'],
  ['an empty message', ''],
  ['an unknown message', 'something went wrong'],
];

describe('isSandboxLaunchFailure', () => {
  for (const [name, message] of SANDBOX_FAILURES) {
    it(`reads ${name} as a sandbox failure`, () => {
      expect(isSandboxLaunchFailure(message)).toBe(true);
    });
  }

  for (const [name, message] of OTHER_FAILURES) {
    it(`does not read ${name} as a sandbox failure`, () => {
      expect(isSandboxLaunchFailure(message)).toBe(false);
    });
  }

  it('does not read a launch line that names --no-sandbox as a sandbox failure', () => {
    // An unsandboxed launch lists --no-sandbox among its arguments. That alone says nothing about
    // why the launch failed.
    expect(
      isSandboxLaunchFailure(
        'browserType.launch: Target page, context or browser has been closed\nCall log:\n  - <launching> /opt/chrome --no-sandbox --headless\n  - [pid=1000][err] Received signal 6',
      ),
    ).toBe(false);
  });
});
