# Run the proof loop

Use this guide to experience the modal focus defect, see the usabl result, repair
the accessibility behavior, and verify the changed code.

Read [How usabl works](../how-usabl-works.html) if you want to understand how
coverage, providers, the gate, receipts, and product surfaces produce this result.

Allow 30 to 45 minutes. Pair with a developer if you do not normally work in a
terminal.

## Before you start

You need:

- Access to the private `usabl-dev/usabl` and `usabl-dev/usabl-app` repositories.
- Node.js 22 and npm.
- Both repositories cloned into the same parent directory.
- The package execution fix from
  [usabl PR 54](https://github.com/usabl-dev/usabl/pull/54).

If PR 54 is not merged, use its branch only with a maintainer. Do not treat an
empty command result as a pass.

## 1. Prepare the workspace

```bash
git clone https://github.com/usabl-dev/usabl.git
git clone https://github.com/usabl-dev/usabl-app.git

cd usabl
npm install
npm run build

cd ../usabl-app
npm install
```

Both repositories must remain siblings because `usabl-app` currently uses
`file:../usabl`.

## 2. Start the fixture

From `usabl-app`:

```bash
npm run dev
```

Open `http://127.0.0.1:5173/clusters`.

Select **View cluster details**. Press `Escape`.

Expected broken behavior:

- The dialog closes.
- Focus does not return to **View cluster details**.
- A keyboard user loses their place.

If focus returns correctly on the default URL, stop. Record the branch and commit
you are using because the fixture is already fixed.

## 3. Run usabl

Keep the fixture running. Open another terminal in `usabl-app`:

```bash
npx usabl check
```

Expected result:

- Verdict: `regression`
- Rule: `pf-modal-focus-return`
- Exit code: 1
- Receipt: none

If the command prints no Result, stop. Do not report verified. Confirm that the
engine includes PR 54 and rebuild `usabl`.

## 4. Inspect the other surfaces

- **Overlay:** open the running fixture without `?usabl=off`. The badge should show
  the same regression. The overlay advises. It does not decide a second result.
- **AI stop hook:** if your environment has the hook installed, ask the assistant
  to finish work on the broken fixture. It should stop and report the regression.
- **Pull request:** the trusted CI path runs when a pull request changes mapped
  interface files. Do not open a throwaway pull request only for this exercise.

## 5. Make the default route use the fixed behavior

Create a branch in `usabl-app`:

```bash
git switch -c test/fix-modal-focus-return
```

Open `src/lib/variant.ts`. Change the selection rule so the normal route uses the
fixed behavior and the explicit `?variant=broken` URL preserves the broken demo
case:

```ts
export function readVariant(): Variant {
  return new URLSearchParams(window.location.search).get('variant') === 'broken'
    ? 'broken'
    : 'fixed'
}
```

This is a real source change. It does not use `?variant=fixed` to bypass the team
exercise.

Run the app tests:

```bash
npm test
npm run build
```

## 6. Verify the behavior

Reload `http://127.0.0.1:5173/clusters`.

Select **View cluster details**. Press `Escape`.

Expected fixed behavior:

- The dialog closes.
- Focus returns to **View cluster details**.
- Pressing `Enter` opens the dialog again.

Run usabl again:

```bash
npx usabl check
```

Expected result:

- Verdict: `verified`
- Exit code: 0
- A receipt bound to the checked source state

Open `http://127.0.0.1:5173/clusters?variant=broken` to confirm that the explicit
broken demonstration still exists.

## 7. Record the outcome

If any expected result differs, follow the
[test and report guide](test-and-report.md). Include:

- Engine and app commit IDs
- URL tested
- Command used
- Result seen
- Result expected
- Whether browser behavior matched the usabl result

Delete the exercise branch when you no longer need it, or turn the work into a
focused pull request with team agreement.
