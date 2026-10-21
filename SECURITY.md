# Security policy

## Report a vulnerability

Report vulnerabilities privately through GitHub private vulnerability reporting:

1. Open the [Security tab](https://github.com/usabl-dev/usabl/security) of this
   repository.
2. Select **Report a vulnerability**.
3. Describe the problem, the affected version, and the steps to reproduce it.

Never report a vulnerability in a public issue, pull request, or discussion.

The maintainer will confirm the report and work with you on a fix.

## What counts as a security issue

usabl is a gate. Its job is to say whether a change introduced an accessibility barrier,
and to refuse to say "verified" when it cannot prove it. A security issue is anything
that breaks that promise or exposes data:

- **An untrusted input changes a verdict.** For example, a pull request, page text,
  config, or a route file that changes the policy it is checked against, approves
  itself, or steers which screens are scanned.
- **A false result reads as true.** For example, a run that skipped a screen, scanned
  the wrong page, or crashed, but reports `verified` or produces a receipt.
- **A secret leaks.** For example, a token, credential, session file, or cookie that
  appears in a result, receipt, log, pull request comment, or error message.

A barrier that usabl misses on an app is usually a bug, not a vulnerability. Report it
with the [bug report form](https://github.com/usabl-dev/usabl/issues/new?template=bug_report.yml).
If you are not sure which it is, report it privately.

## Supported versions

Security fixes go into the latest release only. Update to the latest release to get
them.

## Threat model

The [threat model](docs/threat-model.md) lists the attacks usabl defends against, how
each defense works, and the risks that are accepted.
