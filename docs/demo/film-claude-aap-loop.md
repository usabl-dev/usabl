# Film script: `/usabl-check` + stop hook on ansible-ui-demo (Claude Code)

One take, about 3 to 4 minutes. You type the prompts; the agent does the code. This is a
**single-barrier** demo: the script injects one **new** regression (a decorative image with no
alternative text) on the users screen, the stop hook blocks the finish, and the agent adds the
missing `alt` to clear it. The recorded **Automation Hub** contrast debt is shown in the overlay
but not fixed on camera: it is recorded floor debt, it never gates, and fixing it edits a global
chrome file mapped to no surface, which would open a coverage gap. This is the Claude Code twin of
`film-cursor-aap-loop.md`; the beats match, only the wiring differs.

Paths on this machine:

| What | Path |
| --- | --- |
| Application | `/home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo` |
| Engine | `/home/eparenti/work/repos/innovation-days-2026/usabl` |
| Session file | `/home/eparenti/work/repos/innovation-days-2026/aui-session-live.json` |
| Demo env | `/home/eparenti/work/repos/innovation-days-2026/demo.env` |

## How Claude Code wiring differs from Cursor

| Piece | Cursor | Claude Code |
| --- | --- | --- |
| Stop hook | `.cursor/hooks.json` + `.cursor/hooks/usabl-stop.sh` (executable, `chmod +x`), runs `npx usabl stop-hook --cursor` | `.claude/settings.json` `hooks.Stop` runs `npx usabl stop-hook` (a command string, no script, no chmod) |
| Loop protocol | Cursor `followup_message`, `loop_limit: 3` | Claude Stop-event JSON; the engine returns block-with-reason and Claude keeps going until fixed or bypassed |
| Mid-task check | `/usabl-check` slash command | `/usabl-check` skill (`.claude/skills/usabl-check/SKILL.md`) |
| Fix affordance | prompt the agent | `/usabl-fix` skill (`.claude/skills/usabl-fix/SKILL.md`) or a plain prompt |
| Let one stop through | remove the hook / edit config | `usabl bypass` (allows the next stop only) |

## Before you roll (15 minutes, off camera)

1. **Hosts** (once per machine):

   ```
   echo '127.0.0.1 aap.lab.example.com' | sudo tee -a /etc/hosts
   ```

2. **Bring the stack up** (from the engine clone):

   ```
   WORKDIR=/home/eparenti/work/repos/innovation-days-2026 \
   DEMO_APP=/home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo \
   USABL_ENGINE=/home/eparenti/work/repos/innovation-days-2026/usabl \
   /home/eparenti/work/repos/innovation-days-2026/usabl/docs/demo/start-demo.sh
   ```

   Wait for `ready`. First boot can take several minutes.

3. **Wire Claude Code** (once per clone, from the application root). No chmod, unlike Cursor:

   ```
   cd /home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo
   node /home/eparenti/work/repos/innovation-days-2026/usabl/dist/cli.js install --claude
   node /home/eparenti/work/repos/innovation-days-2026/usabl/dist/cli.js install --claude-skill
   ```

   `--claude` writes the Stop hook into `.claude/settings.json`; `--claude-skill` writes the
   `usabl-check` and `usabl-fix` skills under `.claude/skills/`. Both are idempotent: a second run
   reports "No change" if they are already wired. In this clone they are already installed.

4. **Open Claude Code on the application repo**, not the engine repo. The Stop hook and both skills
   run `npx usabl ...` from the application root (its `node_modules/usabl` is symlinked to the
   engine, so `npx usabl` resolves without a registry fetch). The hook and skills read the scanner
   session from `USABL_STORAGE_STATE`, so it must be in Claude Code's own environment. Launch it
   with the variable set:

   ```
   cd /home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo
   USABL_STORAGE_STATE=/home/eparenti/work/repos/innovation-days-2026/aui-session-live.json claude
   ```

   Setting it inside the session (or only in your browser terminal) is not enough: the hook runs in
   the environment Claude Code was started with.

5. **Reset to the recorded-floor baseline** (no film edits):

   ```
   cd /home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo
   npm run demo:film:reset
   git checkout -- .
   npm run demo:film:status    # expect nav=broken, users-break=no
   ```

   The film toggle is `npm run demo:film:break|repair|reset|status`; each aliases
   `node scripts/set-film-demo.mjs <mode>` in `package.json`. Both the aliases and the script are
   committed on `devel`, so the `git checkout -- .` steps above and in cleanup keep them.

6. **Give Beat 1 a screen to grade.** The overlay and `usabl check` are change-driven: a clean tree
   shows **nothing to check / IDLE**, because no screen is in the change scope. To open on the
   VERIFIED-carrying-29 state (Beat 1), the users screen must be in scope. Add the benign baseline
   edit `setup-ansible-ui-team.sh` uses:

   ```
   printf '%s\n' '// demo: edit on the users screen so usabl grades this change' \
     >> platform/routes/useGetPlatformUsersRoutes.tsx
   ```

   This is a comment on a file in the `/access/users` route closure. It adds no barrier, so the run
   stays VERIFIED with 29 recorded, and it is reverted with the rest in the cleanup step. Skip this
   only if you plan to open the take on Beat 2 (the regression) instead.

7. **Log in with your own browser** at `http://localhost:4100/access/users` (`admin` / `redhat`).
   Use `localhost`, never `127.0.0.1`.

8. **Mint a fresh session** right before filming (it lives about 15 minutes):

   ```
   WORKDIR=/home/eparenti/work/repos/innovation-days-2026 \
   /home/eparenti/work/repos/innovation-days-2026/usabl/docs/demo/mint-session.sh
   ```

---

## On camera

### Beat 1 - Show the finding (overlay, ~60s)

1. Browser on `http://localhost:4100/access/users`, logged in.
2. Open the **usabl accessibility inspector** (docked on the right).
3. Confirm header: **Verified**, exit code 0, "Nothing blocks this run", 29 recorded. If it reads
   "nothing to check", the users screen is not in scope; apply the Beat-1 baseline edit from step 6
   and reload.
4. Expand the **color-contrast** finding on **Automation Hub** (`#platform-hub`).
5. Click **Move focus to it** so the red outline lands on the Hub nav subtitle. Optional keyboard
   beat: Tab a few times, Shift+Tab back onto it, then press Escape to return to the panel.
6. One-liner: "This is recorded debt. It does not block, so we are not fixing it today, but the
   inspector still surfaces it." This sets up the contrast as debt you deliberately leave alone,
   not the thing you fix on camera.

### Beat 2 - Inject a regression (~30s)

In a terminal (application root):

```
cd /home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo
npm run demo:film:break
```

Say: "I am shipping a small UI change." This adds a decorative image without alternative text on
the users page. That is a **new** barrier above the floor, so the stop hook can block.

Save/reload the browser if Vite did not hot-reload yet.

### Beat 3 - Mid-task check (~90s)

In Claude Code, type exactly:

```
/usabl-check
```

The skill runs `npx usabl check --self-check`. Narrate:

- Verdict should be **REGRESSION** (exit 1 in the payload, but the self-check stays advisory).
- One blocking finding: the new **image-alt** barrier on the users screen.
- 29 recorded, not blocking (the Hub contrast debt is in there, carried, not gating).
- No coverage gap.

### Beat 4 - Ask for the fix (~90s)

Type the `/usabl-fix` skill, or paste (or paraphrase) this prompt:

```
usabl flagged a blocking accessibility barrier on this change: the decorative image with no
alternative text on the users page in platform/access/users/components/PlatformUsersList.tsx.
Mark it decorative with an empty alt so screen readers skip it. Re-run usabl check when done.
```

Scope the ask to the **image only**. Do not ask the agent to fix the nav contrast: it is recorded
floor debt (non-blocking), and fixing it edits a framework file mapped to no surface, which opens a
coverage gap and derails the take. Either way, let the agent edit source. Do **not** run
`npm run demo:film:repair` yourself on camera unless the agent is stuck; that script removes the
image barrier for recovery and leaves the nav at floor. The point is the agent applies the real fix.

### Beat 5 - Stop hook blocks (~60s)

When the agent says it is done, let the turn end. The **Stop hook** (`npx usabl stop-hook`) fires
on Claude's Stop event and blocks the finish, feeding the agent a block message that lists the
gating barriers (image-alt and/or contrast). The agent picks the work back up on its own.

If it allows the stop instead:

- Confirm Claude Code was launched with `USABL_STORAGE_STATE` set (Beat 4 in "Before you roll").
- Confirm `.claude/settings.json` has the `hooks.Stop` entry running `npx usabl stop-hook`
  (`usabl install --claude` reports "already runs the usabl Stop hook").
- Run `npm run demo:film:status` and confirm `users-break=yes` and `nav=broken` if the agent has
  not fixed anything yet.

Narrate: "The assistant cannot certify its own work. The gate blocks the first stop."

### Beat 6 - Finish the repair (~60s)

The agent adds the empty `alt` and re-runs the check. Type `/usabl-check` again to confirm.
Expect **VERIFIED**, exit 0, nothing blocking, 29 recorded, and **no coverage gap**. Let the agent
stop; the Stop hook should now **allow** the finish.

If the check still reports a gap naming `PageNavigation.tsx`, the agent also touched the nav
contrast. Ask it to revert the nav change and keep only the `alt` fix, then re-check.

To show the finish deliberately without another fix loop, `usabl bypass` lets the next stop through
once (it prints "BYPASS set for the next stop only"). Use it only to demonstrate the escape hatch,
not to skip an unfixed regression on camera.

Optional terminal proof:

```
cd /home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo
USABL_STORAGE_STATE=/home/eparenti/work/repos/innovation-days-2026/aui-session-live.json \
  node /home/eparenti/work/repos/innovation-days-2026/usabl/dist/cli.js check
```

### Beat 7 - Overlay after fix (~30s)

Reload `http://localhost:4100/access/users`. The header returns to **Verified**, 29 recorded, and
the injected image no longer flags an image-alt barrier. The Automation Hub contrast finding is
still present as recorded debt: the point is that the blocking regression the agent introduced is
gone, while the pre-existing debt the team chose not to fix today is still tracked, not silently
dropped.

---

## After filming

```
cd /home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo
npm run demo:film:reset
git checkout -- .
```

`git checkout -- .` also drops the Beat-1 baseline comment from step 6. Commit the repair only if
you want it on `devel`. The film scripts and the `.claude` wiring are safe to keep.

---

## Quick recovery

| Symptom | Fix |
| --- | --- |
| Overlay says "nothing to check" | Clean tree, no screen in scope. Apply the Beat-1 baseline edit (step 6) or run `npm run demo:film:break`, then reload |
| Sign-in page instead of Users | Use `localhost:4100`, remint session, log in again |
| `not_covered` / connection refused | Rerun `start-demo.sh`, remint session |
| `not_covered` naming 401s on the scanned URL | Scanner session expired (~15 min). Remint with `mint-session.sh` |
| Overlay idle | Hard refresh; confirm dev server on 4100 |
| Stop hook silent / allows the finish | Relaunch `claude` with `USABL_STORAGE_STATE` set; confirm `.claude/settings.json` has the `hooks.Stop` entry (`usabl install --claude`) |
| `/usabl-check` or `/usabl-fix` missing | `usabl install --claude-skill`; the skills live in `.claude/skills/` |
| Scan takes forever | Do not edit `vite.config.ts`; cut away during the 90s scan |
| Agent fixed via npm script | Cut that take; prompt it to edit source instead |
| `not_covered` naming `PageNavigation.tsx` | Agent also fixed the nav contrast. Ask it to revert that and keep only the `alt` fix; the contrast is debt you leave alone |

## What changed in source (for your notes)

**Film break** (`PlatformUsersList.tsx`): 1x1 decorative `<img>` with no `alt` (the new regression
the stop hook blocks). The agent's fix is an empty `alt=""` marking it decorative.

**Coverage mapping** (`usabl.config.json`, committed on `devel`): the `users` surface `files` list
includes `platform/access/users/components/PlatformUsersList.tsx`, so the agent's fix on that
component is attributed to the users surface and the run reaches VERIFIED. Without this mapping the
fix returns NOT COVERED and the agent cannot clear the gate, which is what derailed earlier takes.

**Nav contrast** (`framework/PageNavigation/PageNavigation.tsx`): left at `opacity: 0.5` (the
recorded floor debt). Not fixed on camera. Fixing it would edit this framework file, which is
mapped to no surface, and open a fresh `not_covered` gap.
</content>
</invoke>
