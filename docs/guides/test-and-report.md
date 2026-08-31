# Test and report

Use this guide to turn an accessibility observation into feedback another
teammate can reproduce. You do not need to write code.

Read [How usabl works](../how-usabl-works.html) before testing result meaning,
coverage, or agreement between product surfaces.

## Choose one surface

Test one surface at a time:

- Browser behavior in `usabl-app`
- The in-app overlay
- Command output
- The accessible documentation page from `usabl docs --html`
- AI stop-hook behavior
- Pull request comment and check status
- The team orientation or one of these guides

## Browser keyboard test

1. Open `http://127.0.0.1:5173/clusters`.
2. Use `Tab` until **View cluster details** has focus.
3. Press `Enter` to open the dialog.
4. Press `Tab` and `Shift+Tab`.
5. Press `Escape` to close the dialog.
6. Press `Enter` again.

Record:

- Where focus started
- Whether focus moved inside the dialog
- Whether focus stayed inside while the dialog was open
- Where focus went after close
- Whether the next action was clear

## Screen-reader test

Use the screen reader and browser you normally use. Record both names and versions.

On the Clusters screen, listen for:

- The **View cluster details** control and its dialog relationship
- The dialog name, **Cluster details**
- The dialog description
- The **Close** button
- The control announced after the dialog closes

Do not convert a personal judgment into a verified claim. Report what you heard and
whether it matched the visible behavior.

## Result clarity test

Read the result without looking at source code. Answer:

1. What did usabl check?
2. What result did it give?
3. What should happen next?
4. What evidence can you inspect?
5. What, if anything, was not covered?

If one answer is unclear, quote the exact label or sentence that caused the problem.

## File useful feedback

Open the
[usabl feedback form](https://github.com/usabl-dev/usabl/issues/new?template=feedback.yml).

Complete these fields:

- **Surface:** where you saw the result
- **Verdict seen:** the exact usabl answer
- **Expected verdict:** what you expected
- **Repro:** numbered steps, URL, command, and pull request link when relevant
- **Honest or confusing:** whether the output matched what happened and what was
  unclear

Add environment details when they affect the result:

- Operating system
- Browser and version
- Screen reader and version
- Engine and app commit IDs

## A useful report

A teammate should be able to follow your steps without asking what you clicked,
which URL you used, or what result you saw. If they cannot, add the missing detail
before submitting.
