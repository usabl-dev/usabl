# Rehearse the demo

Use the [usabl-app team demo runbook](https://github.com/usabl-dev/usabl-app/blob/main/README.md) as the exact sequence. Do
not copy its commands into another guide.

Read [How usabl works](../how-usabl-works.html) before explaining the Result,
receipt, or enforcement boundary.

## Demo outcome

The audience should see:

1. Clear accessibility barriers in Deployments and Clusters.
2. One Regression Result with eight findings, covering the barriers across the
   Deployments and Clusters screens, shown the same way in the browser, Claude, and
   pull request.
3. The mid-session Claude check remain advisory.
4. The Claude Stop hook and CI check block completion.
5. The source repair change the actual accessibility behavior.
6. A Verified Result and receipt bound to the repaired working tree.

## Rehearsal roles

- The primary operator drives the browser, Claude, terminal, and pull request.
- The backup operator tracks time, checks expected evidence, and takes over when
  a live step fails.

Both operators should complete the full runbook before the contest demo.

## Evidence to capture

- The broken browser behavior and the Regression inspector.
- The Claude mid-session result and Stop hook block.
- The failed pull request check and Regression comment.
- The focused accessibility source diff.
- The repaired browser behavior and Stop hook allow.
- The passed pull request check and Verified receipt.

Label every artifact with the app commit, engine commit, and Result. Do not use
evidence from a different source state.

## Recovery practice

Practice these cases:

- The fixture does not start.
- The inspector is absent or Idle.
- Claude does not load the project skill or Stop hook.
- The Result is Not covered.
- The pull request cannot check out the trusted engine.
- The network is unavailable.

For each case, state what is missing, choose the matching backup evidence, and
decide whether the live demo can continue. Never describe a failed or missing
check as Verified.

## Ready condition

The demo is ready when two people can deliver it to time, explain every surface,
show evidence for every claim, and recover from each practiced failure.
