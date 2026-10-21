# Run the accessibility proof loop

The [usabl-app README](https://github.com/usabl-dev/usabl-app/blob/main/README.md)
walks you through the whole loop on a small PatternFly sample app with known
accessibility barriers. It is the single source for setup, commands, expected
results, repair, and recovery.

Start with the [usabl walkthrough](../usabl-walkthrough.html). Read
[How usabl works](../how-usabl-works.html) when you need the result model, trust
boundary, or system design.

The sample app README guides you through:

1. Experiencing several accessibility barriers in teaching previews.
2. Changing the tracked source to the broken state.
3. Reading the single Regression Result, with findings grouped by screen across the
   Deployments and Clusters screens, in the advisory browser inspector.
4. Running the assistant's `/usabl-check` self-check.
5. Seeing the Claude Stop hook block completion.
6. Seeing the pull request check and sticky comment report Regression.
7. Repairing the tracked accessibility state.
8. Verifying the browser behavior, pull request, and working-tree receipt.

Use the [test and report guide](test-and-report.md) when an observed result does
not match the accessibility behavior.
