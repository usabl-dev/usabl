# How sensitive is usabl

`usabl verify sensitivity` puts declared accessibility defects on pages, one at a time, and records
whether the checks and the gate catch each one. Use it to see what usabl notices, on pages where the
defect is known to be there. It measures. It does not judge a screen, and it changes no verdict.

## Run it

```bash
npx usabl verify sensitivity
```

This runs Level 1: every catalog defect on small fixture pages that ship with usabl. It needs no
app and no config, only Playwright's Chromium. It takes a few minutes, because each defect loads
its page twice and runs the full scan both times.

To run the same defects on your own screens too:

```bash
npx usabl verify sensitivity --app
npx usabl verify sensitivity --app --screen settings clusters
```

This is Level 2. It reads the surfaces in `usabl.config.json`, so your app must be running at the
URLs listed there. It loads each screen twice for every defect, so it is slow on many screens. Use
`--screen` to name a few.

Add `--json` to print the whole attestation instead of the summary.

## What it writes

The command writes `.usabl/sensitivity.json` and prints a short summary, for example:

```text
On the fixture pages: caught 25 of 28 catalog defects.
  caught 25, caught by another rule 0, missed 2, preview only 1, not applicable 0, unreadable 0
  Missed:
    control-out-of-tab-order on sensitivity-basic. Expected: no shipped rule. ...
```

The file holds the engine and scanner versions, the catalog hash, the date, and one row per defect
and screen: the outcome, the rules that reported it, and the reason for any outcome other than
caught. It also lists every shipped rule the catalog does not exercise, with the reason. The command
exits 0 whenever it ran and wrote the file, even when defects were missed. It exits 4 only when it
could not run, and 2 when a flag is wrong.

## What each outcome means

- **caught**: a rule expected to report the defect reported something new, on the changed element,
  and the gate would block it.
- **caught by another rule**: something new would block, but from another rule, or somewhere else on
  the page. It is counted apart from caught.
- **missed**: nothing new would block. The summary names the defect and what was expected.
- **preview only**: the only new finding is preview evidence, which never blocks. Voice findings are
  preview until a person promotes the class.
- **not applicable**: the screen cannot carry the defect, for example a screen with no table for a
  table defect.
- **unreadable**: one of the two scans had a coverage gap, or the change could not be made. Such a
  scan proves nothing either way.

"Caught 25 of 28" counts only the defects that were made and read. Not applicable and unreadable
rows are listed, never counted as caught. A level where nothing could be made and read is reported
as measuring nothing, not as a pass.

## What Level 1 found

On the fixture pages, two defects are missed:

- `control-out-of-tab-order`: a visible button with `tabindex="-1"`. Keyboard users cannot reach it,
  and no shipped rule reports a control that Tab never reaches.
- `menu-does-not-open-on-enter`: a menu that opens on a click but not on Enter. The PatternFly menu
  probe opens menus with a click, so it does not see this.

`voice-live-region-broken` is preview only, as expected for voice findings today.

## Limits

- A catch on the fixture pages is a catch on that markup. Your screens can differ.
- On your app, a change can land on an element where it creates no barrier, for example a live
  region your flow does not use. That reads as missed. Read a Level 2 miss with the screen open.
- The changes run in the page's own script world, so your page's own script can see them.
- Only the defects in the catalog are measured. A defect that is not in the catalog is not
  measured at all.

The [ground truth](../ground-truth.md) section 25 describes the catalog, the run, and the
attestation in full. The [threat model](../threat-model.md) says why a normal `usabl check` can
never make these changes.
