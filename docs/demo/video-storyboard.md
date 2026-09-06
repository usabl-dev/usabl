# usabl demo: video storyboard

Working document for the A/V edit. Target length is about five minutes. This is a
handoff for the video producer, not marketing copy.

## Format decisions (locked)

- Voiceover only. No on-camera presenter.
- Real screen reader recordings carry the human moments. usabl never plays a screen
  reader. The cold open uses a real recording of the barrier, and the bookend uses a
  real recording of the same screen working after the fix.
- The product demo (scene 3) is a recorded run, not a live run on stage.
- No hard defect counts anywhere in the narration. Tell the story, show one real issue
  on screen instead of quoting a number.

## How to read this

Each scene is a set of numbered shots. Shot IDs are stable (1.1, 1.2), so you can cut,
reorder, or drop a shot without renumbering the rest. Durations are per shot and are the
source of truth. Running times are derived from the durations, so if you resequence, only
the running times change. Each shot lists Picture, Audio, VO, Text and graphics,
Transition, and Intent.

The full narration, in order, is collected at the end under "Narration script" for a
quick read and a timing pass.

---

## Scene 1: cold open

**Working title:** Done, and then shipped
**Runs:** about 28 seconds
**Purpose:** Follow one barrier from the keyboard, through the pipeline, to a real person
weeks later. End on the person. The narrator does not speak until scene 2.

**Shot 1.1**, duration ~7s, running 0:00 to 0:07
- **Picture:** A code assistant chat panel, clean and bright. A developer asks for a
  dialog. The assistant returns code and signs off: "Done. I added the details dialog with
  row actions." A green check. Pull the word "Done." large for a beat.
- **Audio:** Quiet keyboard, one soft confirmation tone.
- **VO:** none.
- **Text and graphics:** the assistant message, then "Done." enlarged.
- **Transition:** cut.
- **Intent:** The claim, made at the keyboard, before anyone else has seen it.

**Shot 1.2**, duration ~6s, running 0:07 to 0:13
- **Picture:** The change leaves the developer and moves downstream. Quick clean beats: a
  merge, a green pipeline, a deploy, a release tag. A small date stamp advances, for
  example from a build date to a date weeks later.
- **Audio:** A neutral, moving music bed enters.
- **VO:** none.
- **Text and graphics:** the advancing date is the only text.
- **Transition:** the date settles on the later day, then cut.
- **Intent:** Show that days or weeks pass, and that the change sailed through every step
  on the way out.

**Shot 1.3**, duration ~10s, running 0:13 to 0:23
- **Picture:** Weeks later. A real person using a screen reader opens that same dialog.
  They try to leave it. Focus is trapped. The screen reader loops or goes silent. Hold the
  dead air for about a second.
- **Audio:** Real screen reader output. Music ducks under it, then out.
- **VO:** none.
- **Text and graphics:** none.
- **Transition:** hold on the stuck screen.
- **Intent:** The claim reaches a person, long after it was made, and fails them.

**Shot 1.4**, duration ~5s, running 0:23 to 0:28
- **Picture:** Stay on the stuck screen. No new graphics.
- **Audio:** Silence, or a single low note.
- **VO:** none.
- **Text and graphics:** none.
- **Transition:** dip to black, then into scene 2.
- **Intent:** Let the wall sit. The narrator arrives fresh in scene 2 and explains how it
  got all the way here.

---

## Scene 2: how it got all the way here

**Working title:** Nobody was required to disagree
**Runs:** about 40 seconds
**Purpose:** Name the time gap and the pipeline. Introduce the twist that the writer
is also the grader (they need usabl to solve this problem and prevent this from happening). Introduce usabl, the four verdicts and the no-verdict case, and the product promise. The narrator
enters here.

**Shot 2.1**, duration ~12s, running 0:28 to 0:40
- **Picture:** A simple timeline. The change from scene 1 travels left to right through
  labeled stages: code review, tests, CI, release. Each stage lights green as it passes. A
  small marker for the barrier rides along, untouched.
- **Audio:** Narrator, calm and plain. Low bed under it.
- **VO:** "That barrier did not sneak out. It passed a code review, a test suite, and a
  release. Every step was a chance to catch it. Every step let it through."
- **Text and graphics:** stage labels, and a span marked "weeks."
- **Transition:** cut.
- **Intent:** The journey had many chances and took none of them.

**Shot 2.2**, duration ~9s, running 0:40 to 0:49
- **Picture:** The stages replay, and a callout on each says it never checks whether a
  screen reader can operate the change.
- **Audio:** narrator.
- **VO:** "None of those steps was ever required to disagree. Accessibility was the one
  thing no gate was holding."
- **Text and graphics:** the phrase "it must be usabl(e)" on screen.
- **Transition:** cut.
- **Intent:** Land the core idea of the film in one line.

**Shot 2.3**, duration ~10s, running 0:49 to 0:59
- **Picture:** Back to the assistant chat. The same assistant (Claude Code) writes the code, then in the
  next message judges it: "Looks good. Done." Highlight that the writer and the grader are
  the same panel.
- **Audio:** narrator.
- **VO:** "And now the assistant that writes the code is the one that says it is done. It
  grades its own work, from inside its own confidence."
- **Text and graphics:** underline that one panel both writes and signs off.
- **Transition:** cut.
- **Intent:** Show why the old pipeline gap got worse, not better.

**Shot 2.4**, duration ~9s, running 0:59 to 1:08
- **Picture:** The four verdict chips appear: verified, regression, not covered, approval
  required. The verified chip is highlighted. The tagline lands at the end.
- **Audio:** narrator.
- **VO:** "usabl is built to be the thing that ensures a11y is a top priority. On the surfaces a change touches,
  it returns one of four answers, or none when nothing was checked or the run could not decide. Only verified counts as
  proof, and on a blocking verdict the assistant's first stop is blocked. The
  assistant can propose the fix. The rules decide whether it passes."
- **Text and graphics:** four chips, then "Don't ship until it's usabl."
- **Transition:** cut into the demo.
- **Intent:** Introduce the product and the promise, and set up exactly what the demo will
  show.

---

## Scene 3: the moment

**Working title:** Blocked, then verified
**Runs:** about 95 seconds
**Purpose:** Show the loop end to end. Break a dialog, let usabl explain it, watch the
assistant get blocked when it tries to finish, apply the real fix, and mint a receipt.
Close the scene on a defect a normal scanner cannot see. This is the headline. Give it
room.

**Shot 3.1**, duration ~25s, running 1:08 to 1:33
- **Picture:** The fixture app running clean in a browser, screen recorded. A code edit
  breaks the dialog. Flash the git diff for about one second so the broken code is visibly
  real source. Save. The dev-server overlay slides in and states, in plain words, what a
  user experiences, why it is wrong, and how to fix it.
- **Audio:** narrator, then the app.
- **VO:** "Here is the same kind of dialog inside a real dev loop. A change breaks it. On
  save, usabl says what a user would experience, why it is wrong, and how to fix it, right
  there in the browser."
- **Text and graphics:** the overlay content is the on-screen text. A one second flash of
  the git diff.
- **Transition:** cut to the chat.
- **Intent:** Show the real-time guidance, and prove the break is real source, not a
  staged flag.

**Shot 3.2**, duration ~30s, running 1:33 to 2:03
- **Picture:** The assistant chat. The developer asks the assistant to fix it. The
  assistant proposes a change, then tries to end the task with a "Done" message. A red
  block lands over it. The stop hook output appears.
- **Audio:** narrator.
- **VO:** "The assistant proposes a fix, then tries to end the task. usabl blocks it at the
  moment it tries to say done. And the assistant cannot talk its way past this. Only a
  real, repeatable check can turn the light green. The assistant's own opinion is shown to
  the developer, and it never counts as proof."
- **Text and graphics:** "AI proposes. The gate decides."
- **Transition:** cut.
- **Intent:** The headline beat. The assistant is structurally unable to certify itself.

**Shot 3.3**, duration ~40s, running 2:03 to 2:43
- **Picture, part one:** Apply the real fix. Re-run. The verdict chip flips from regression
  to verified. A receipt card mints with a stamp and shows four bound values: the source
  tree, the policy, the engine version, and the exact scanner and browser versions.
- **VO, part one:** "Apply the real fix, and the verdict flips to verified. usabl mints a
  receipt. It records the exact code, the policy, the engine, and the exact scanner and
  browser that made the call, so anyone can re-check it later."
- **Picture, part two:** A two-panel comparison. On the left, a standard accessibility
  scanner reports zero problems on the broken dialog. On the right, usabl reports a
  regression. Under it, a clip of Escape being pressed while focus lands nowhere.
- **VO, part two:** "And this is a problem a normal scanner cannot see. A dialog that fails
  to send focus back when you press Escape is not a mistake in the markup. It only exists
  after a key is pressed. usabl opens the dialog, presses Escape, and checks where focus
  actually went."
- **Audio:** narrator.
- **Text and graphics:** left panel labeled "standard scanner: 0 issues," right panel
  labeled "usabl: regression."
- **Transition:** cut to scene 4.
- **Intent:** Prove the receipt is re-checkable and that usabl catches what static tools
  miss.

---

## Scene 4: you cannot quietly turn it off

**Working title:** The rules guard themselves
**Runs:** about 37 seconds
**Purpose:** Show that the policy cannot be edited away, and that on a pull request the
rules are read from the protected branch. This scene stops at approval required blocking.
See the claim guardrails at the end before changing it.

**Shot 4.1**, duration ~20s, running 2:43 to 3:03
- **Picture:** Someone opens usabl.config.json and deletes the failing surface to make the
  problem go away. Re-run. The verdict turns to approval required. The run stops.
- **Audio:** narrator.
- **VO:** "Any check like this can be turned off by editing its own config. So usabl guards
  its own rules. Change the config, the accepted list, or the waiver file, and usabl stops
  and asks a person to sign off. You cannot make the problem disappear by editing the thing
  that defines the problem."
- **Text and graphics:** "approval required."
- **Transition:** cut.
- **Intent:** The gate cannot be disabled from inside the change.

**Shot 4.2**, duration ~17s, running 3:03 to 3:20
- **Picture:** A simple pull request graphic. Show usabl reading the policy from the
  protected branch, not from the branch under review. A small lock on the protected branch.
- **Audio:** narrator.
- **VO:** "And when it runs on a pull request, it reads those rules from the protected
  branch, not from the branch under review. So you cannot shrink the list of what gets
  checked inside your own change and hide what you touched."
- **Text and graphics:** "policy read from the protected branch."
- **Transition:** cut to scene 5.
- **Intent:** Show the trusted-ref policy read without depicting an approval clearing the gate.

---

## Scene 5: we check ourselves, then the bookend

**Working title:** The same rule, turned on us
**Runs:** about 98 seconds
**Purpose:** Earn trust with the honesty turn, state the principle, show what scales, then
pay off the cold open on the same screen working. Close on the tagline.

**Shot 5.1**, duration ~40s, running 3:20 to 4:00
- **Picture:** Turn usabl on itself. First point it at a real product interface it was not
  built for, and it lights up with findings. Then point it at usabl's own repository, and it
  flags problems in usabl itself. Show one real issue on screen.
- **Audio:** narrator.
- **VO:** "We make a strong claim, that anything usabl cannot check, it reports as a
  failure rather than passing it in silence. So we tested that claim instead of trusting
  it. We pointed usabl at a real application it was not built for, and the claim did not
  fully hold. We found ways it could report nothing without ever really looking, and each
  of those failed toward a green result we had not earned. We fixed them, and we wrote up
  the root cause instead of quietly closing the tickets."
- **Text and graphics:** one real issue title on screen.
- **Transition:** cut.
- **Intent:** This is what makes the rest of the film believable.

**Shot 5.2**, duration ~10s, running 4:00 to 4:10
- **Picture:** A simple two-panel: "the tool" and "how we built it," both showing the same
  rule, that the thing doing the work does not get to certify the work.
- **Audio:** narrator.
- **VO:** "That is the same rule the product runs on. The thing doing the work does not get
  to certify the work. We built that into usabl, and we held ourselves to it while we built
  it."
- **Text and graphics:** the shared rule stated once, centered.
- **Transition:** cut.
- **Intent:** Connect the product idea to how the team worked.

**Shot 5.3**, duration ~18s, running 4:10 to 4:28
- **Picture:** Three quick cards in sequence.
- **Audio:** narrator.
- **VO:** "It is built to scale. The rules target the design system, so a second product
  costs no new rules. A team can turn it on without fixing everything first, because
  today's barriers go on a baseline and only new ones block. And every known barrier gets
  an owner and a date."
- **Text and graphics:** card one, "one rulepack, every product on the design system."
  Card two, "adopt without fixing everything first." Card three, "every known barrier gets
  an owner and a date."
- **Transition:** cut to the bookend.
- **Intent:** Answer "does this work across many products," briefly.

**Shot 5.4**, duration ~30s, running 4:28 to 4:58
- **Picture:** Return to the exact screen from scene 1. The same person, the same screen
  reader, the same dialog. This time they open it, press Escape, and focus returns. The
  screen reader announces the control correctly. They move on. Then the usabl mark and the
  tagline.
- **Audio:** the real screen reader now reads the control correctly, then a low music close.
- **VO:** "Which brings us back to where we started. The same screen, the same dialog. This
  time, when the change was made, something in the pipeline was finally required to
  disagree. And so this time, it works."
- **Text and graphics:** "usabl," then "Don't ship until it's usabl."
- **Transition:** fade out.
- **Intent:** Pay off the cold open. The wall is gone. End on the tagline.

---

## Production requirements

Assets the edit needs, called out early so they can be captured in time.

- Two real screen reader recordings of the same screen: one with the barrier (for scene
  1), one working after the fix (for scene 5). Same voice, same screen, same person if
  possible, so the bookend reads as the same session resolved.
- A recorded run of the product demo for scene 3: the break, the overlay, the blocked stop
  hook, the real fix, and the receipt mint. Capture the git diff of the break on screen.
- A recorded two-panel comparison for shot 3.3: a standard scanner reporting zero problems
  on the broken dialog next to usabl reporting a regression, plus a clip of the Escape
  keypress and focus going nowhere.
- Screen capture of one real issue for shot 5.1.
- Motion graphics: the pipeline timeline (scene 2), the four verdict chips, the receipt
  card, the pull request policy-read graphic (scene 4), and the three scale cards (scene
  5.3).
- One narrator, plain and calm. Full script below.

## Fallback

If the recorded demo cannot be captured cleanly in time, the hero test proves scene 3
beats end to end in a single terminal command. A recording of that run can stand in for
shots 3.1 through 3.3 while keeping the same narration.

## Claim guardrails (do not remove)

These keep the film honest. Do not change them without checking with the team.

- Scene 4 stops at approval required blocking. Do not add a shot of a reviewer approving
  and the gate then clearing. That end to end approval path has a known open defect today,
  so showing it would claim something that does not yet work.
- Scene 5 uses no hard defect count. Show one real issue on screen instead of quoting a
  number.
- The screen reader moments in scenes 1 and 5 are real recordings of a real screen reader.
  usabl does not play or simulate a screen reader, and the film should never imply it does.
- Every claim in the narration maps to something on screen. If a line has no matching
  visual, cut the line or add the visual.

---

## Narration script

Scene 1: no narration.

Scene 2:
"That barrier did not sneak out. It passed a code review, a test suite, and a release.
Every step was a chance to catch it. Every step let it through. None of those steps was
ever required to disagree. Accessibility was the one thing no gate was holding. And now
the assistant that writes the code is the one that says it is done. It grades its own work,
from inside its own confidence. usabl is built to be the thing that disagrees. On the
surfaces a change touches, it returns one of four answers, or none when nothing was checked
or the run could not decide. Only verified counts as proof, and on a blocking verdict the assistant's first stop is
blocked. The assistant can propose the fix. The rules decide whether it passes."

Scene 3:
"Here is the same kind of dialog inside a real dev loop. A change breaks it. On save, usabl
says what a user would experience, why it is wrong, and how to fix it, right there in the
browser. The assistant proposes a fix, then tries to end the task. usabl blocks it at the
moment it tries to say done. And the assistant cannot talk its way past this. Only a real,
repeatable check can turn the light green. The assistant's own opinion is shown to the
developer, and it never counts as proof. Apply the real fix, and the verdict flips to
verified. usabl mints a receipt. It records the exact code, the policy, the engine, and the
exact scanner and browser that made the call, so anyone can re-check it later. And this is a
problem a normal scanner cannot see. A dialog that fails to send focus back when you press
Escape is not a mistake in the markup. It only exists after a key is pressed. usabl opens
the dialog, presses Escape, and checks where focus actually went."

Scene 4:
"Any check like this can be turned off by editing its own config. So usabl guards its own
rules. Change the config, the accepted list, or the waiver file, and usabl stops and asks a
person to sign off. You cannot make the problem disappear by editing the thing that defines
the problem. And when it runs on a pull request, it reads those rules from the protected
branch, not from the branch under review. So you cannot shrink the list of what gets checked
inside your own change and hide what you touched."

Scene 5:
"We make a strong claim, that anything usabl cannot check, it reports as a failure rather
than passing it in silence. So we tested that claim instead of trusting it. We pointed usabl
at a real application it was not built for, and the claim did not fully hold. We found ways
it could report nothing without ever really looking, and each of those failed toward a green
result we had not earned. We fixed them, and we wrote up the root cause instead of quietly
closing the tickets. That is the same rule the product runs on. The thing doing the work
does not get to certify the work. We built that into usabl, and we held ourselves to it
while we built it. It is built to scale. The rules target the design system, so a second
product costs no new rules. A team can turn it on without fixing everything first, because
today's barriers go on a baseline and only new ones block. And every known barrier gets an
owner and a date. Which brings us back to where we started. The same screen, the same
dialog. This time, when the change was made, something in the pipeline was finally required
to disagree. And so this time, it works."
