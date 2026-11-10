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

Level 2 acts on your app the way `usabl check` does, only many more times:

- Each load uses your saved session, if you have one.
- On each load, the dialog and menu probes click every dialog trigger and menu toggle on the screen.
- For the flow and voice defects, your screen's flow and voice steps run on each of their loads. A
  step that saves or deletes data runs that many times. No other defect runs your steps.

Before it starts, the command prints the real counts for the screens you chose: the page loads, and
for each screen with flow or voice steps, how many times they run. Point it at a dev backend whose
data you can lose.

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
caught. A caught row has a reason only when the change did not hold to the end of the scan. It also lists every rule of the checks that can block (axe, PatternFly, RHDS, the keyboard walk, and the docs rules) that the catalog does not exercise, with the reason. Rules that only give preview findings, such as the silent change rule, are not in that list. The command
exits 0 whenever it ran and wrote the file, even when defects were missed. It exits 4 only when it
could not run, and 2 when a flag or the config is wrong.

## What each outcome means

- **caught**: a rule expected to report the defect reported a new, definite failure, and the gate
  would block it. For most defects it must be on the changed element. For the defects a rule reports
  on the page or on the control that opens something (the level one heading, the page title, a
  dialog that does not take focus, and the flow and voice defects), it can be anywhere on the
  screen.
- **caught by another rule**: a new, definite failure on the changed element, but from another
  rule. It is counted apart from caught.
- **missed**: nothing new would block. The summary names the defect and what was expected. When the
  defect is a key that does nothing, and the checks never pressed that key on the element, the
  reason says so.
- **preview only**: the only new finding is preview evidence, which never blocks. Voice findings are
  preview until a person promotes the class.
- **not applicable**: the screen cannot carry the defect, for example a screen with no table for a
  table defect, or the defect was already on the element before the change.
- **unreadable**: the scans cannot say either way. One of these happened:
  - one of the two scans had a coverage gap, or the screen was not seen;
  - the change could not be made, or did not take hold when it was read back at once;
  - the change did not hold through the scan, and nothing was caught: see below;
  - the gate did not verify the changed scan, and no new finding explains why;
  - every new finding that would block is one the checks could not confirm;
  - the only new findings are away from the change, so the page differed between its two loads;
  - on your app, the design requirements could not be loaded, for the flow and voice defects.

After the scan, the change is read back a second time. It did not hold through the scan when the
page put it back, a key got to the page before the change could cancel it, or focus reached the
element in a way the change does not stop. Then a **caught** or **caught by another rule** result
stands, because the new definite failure was found where the rule reports it, while the defect was
there.
Its reason says the change did not hold to the end of the scan, and why. Any other result becomes
**unreadable**, because a miss then proves nothing: the checks may never have seen the defect.

Two more rules keep old findings out. A finding the page already had is not new, even when the
change moved it to a new name. And only a definite failure counts as a catch.

"Caught 25 of 28" counts only the defects that were made and read. Not applicable and unreadable
rows are listed, never counted as caught. A level where nothing could be made and read is reported
as measuring nothing, not as a pass.

## What Level 1 found

On the fixture pages, two defects are missed:

- `control-out-of-tab-order`: a visible button with `tabindex="-1"`. Keyboard users cannot reach it,
  and no shipped rule reports a control that Tab never reaches.
- `menu-does-not-open-on-enter`: a menu that opens on a click but not on Enter. The PatternFly menu
  probe opens menus with a click, so no check ever presses Enter on the toggle.

`voice-live-region-broken` is preview only, as expected for voice findings today.

`menu-toggle-state-removed` is caught. The change removes `aria-expanded` from the menu toggle, and
`pf-kebab-expanded-state` reports it. Then the menu probe clicks the toggle, and the page's own
script sets `aria-expanded` again. By the end of the scan the change is gone, so the row's reason
says so. The catch stands, because the rule reported the defect while it was there.

## Limits

- A catch on the fixture pages is a catch on that markup. Your screens can differ.
- On your app, a change can land on an element where it creates no accessibility barrier, for
  example a live region your flow does not use. That reads as missed. Read a Level 2 miss with the
  screen open.
- The changes run in the page's own script world, so your page's own script can see them.
- A page with no focusable element cannot be measured. The keyboard walk never leaves the body, so
  the screen reads as not seen, and every defect on it is unreadable.
- Pages listed in `usabl.docs.json` are not measured on Level 2. Level 2 reads only the surfaces in
  `usabl.config.json`.
- A finding is located after every check has run. By then a position-based path can name another
  element, for example after a toast was added to the page.
- Only the defects in the catalog are measured. A defect that is not in the catalog is not
  measured at all.

The [ground truth](../ground-truth.md) section 25 describes the catalog, the run, and the
attestation in full. The [threat model](../threat-model.md) says why a normal `usabl check` can
never make these changes.
