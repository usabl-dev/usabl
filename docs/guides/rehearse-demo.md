# Rehearse the demo

Use this guide to make the contest accessibility demo repeatable by two
operators.

Read [How usabl works](../how-usabl-works.html) before explaining the result,
receipt, or product surfaces to an audience.

## Demo outcome

The audience should see:

1. A real keyboard focus defect
2. A regression result that matches the defect
3. The code change that repairs it
4. Correct browser behavior after the change
5. A verified result and re-checkable receipt
6. The same result shown on more than one surface

## Prepare

- Complete the [proof-loop guide](proof-loop.md).
- Use known engine and app commit IDs.
- Start from a clean workspace.
- Confirm Node.js 22 and installed dependencies.
- Confirm the fixture opens at `http://127.0.0.1:5173/clusters`.
- Confirm the command produces a Result before rehearsal starts.

## Assign two operators

- **Primary operator:** drives the browser, terminal, and code change.
- **Backup operator:** tracks time, watches expected results, and takes over if a
  live step fails.

Both operators should be able to complete the full sequence.

## Rehearse the sequence

| Step | Action | Proof on screen |
| --- | --- | --- |
| 1 | Open and close the broken modal | Focus does not return |
| 2 | Run `npx usabl check` | Regression and `pf-modal-focus-return` |
| 3 | Show the mapped source change | Default route selects fixed behavior |
| 4 | Open and close the modal again | Focus returns to the trigger |
| 5 | Run the check again | Verified result and receipt |
| 6 | Show another surface | Overlay or PR comment matches the Result |

Record the time for each step. Cut explanation before cutting proof.

## Capture backup evidence

Capture these before the contest:

- Screenshot or short recording of the broken focus path
- Regression command output
- The focused source diff
- Screenshot or short recording of the fixed focus path
- Verified command output and receipt
- Trusted pull request comment when available

Label every artifact with repository, commit ID, and result. Do not use an artifact
from a different code state as live proof.

## Practice failure recovery

Rehearse these failures:

- The fixture does not start.
- The browser opens the wrong route.
- The command prints no Result.
- The check returns `not_covered`.
- The overlay is hidden.
- The network is unavailable.

For each failure, decide:

1. What the operator says
2. Which local backup artifact they show
3. Whether the live demo continues or stops

Never describe a failed or missing check as verified.

## Ready condition

The demo is ready when:

- Two people can deliver it within the time limit.
- Both can explain all four verdicts and Idle.
- Every live claim has visible evidence.
- Backup artifacts match the rehearsed commits.
- A failed live step has a practiced recovery.
