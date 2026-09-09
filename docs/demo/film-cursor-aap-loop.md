# Film script: `/usabl-check` + stop hook on ansible-ui-demo

One take, about 3 to 4 minutes. You type the prompts; the agent does the code. This is a
**single-barrier** demo: the script injects one **new** regression (a decorative image with no
alternative text) on the users screen, the stop hook blocks the finish, and the agent adds the
missing `alt` to clear it. The recorded **Automation Hub** contrast debt is shown in the overlay
but not fixed on camera: it never gates, and fixing it edits a global chrome file mapped to no
surface, which would open a coverage gap.

Paths on this machine:

| What | Path |
| --- | --- |
| Application | `/home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo` |
| Engine | `/home/eparenti/work/repos/innovation-days-2026/usabl` |
| Session file | `/home/eparenti/work/repos/innovation-days-2026/aui-session-live.json` |
| Demo env | `/home/eparenti/work/repos/innovation-days-2026/demo.env` |

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

3. **Wire Cursor** (once per clone, from the application root):

   ```
   cd /home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo
   node /home/eparenti/work/repos/innovation-days-2026/usabl/dist/cli.js install --cursor
   chmod +x .cursor/hooks/usabl-stop.sh
   ```

4. **Open Cursor on the application repo**, not the engine repo. In that window, export the
   scanner session (add to your shell profile or prefix when launching Cursor):

   ```
   export USABL_STORAGE_STATE=/home/eparenti/work/repos/innovation-days-2026/aui-session-live.json
   ```

5. **Reset to the recorded-floor baseline** (no film edits):

   ```
   cd /home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo
   npm run demo:film:reset
   git checkout -- .
   npm run demo:film:status    # expect nav=broken, users-break=no
   ```

6. **Log in with your own browser** at `http://localhost:4100/access/users` (`admin` / `redhat`).
   Use `localhost`, never `127.0.0.1`.

7. **Mint a fresh session** right before filming:

   ```
   WORKDIR=/home/eparenti/work/repos/innovation-days-2026 \
   /home/eparenti/work/repos/innovation-days-2026/usabl/docs/demo/mint-session.sh
   ```

---

## On camera

### Beat 1 - Show the finding (overlay, ~60s)

1. Browser on `http://localhost:4100/access/users`, logged in.
2. Open the **usabl accessibility inspector** (docked on the right).
3. Confirm header: **Verified**, exit code 0, "Nothing blocks this run", 29 recorded.
4. Expand the **color-contrast** finding on **Automation Hub** (`#platform-hub`).
5. Click **Move focus to it** so the red outline lands on the Hub nav subtitle.
6. One-liner: "This is recorded debt. It does not block, so we are not fixing it today, but the
   inspector still surfaces it."

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

In Cursor chat, type exactly:

```
/usabl-check
```

Let the agent run `npx usabl check --self-check`. Narrate:

- Verdict should be **REGRESSION** (exit 1 in the payload, but the self-check stays advisory).
- One blocking finding: the new **image-alt** barrier on the users screen.
- 29 recorded, not blocking (the Hub contrast debt is in there, carried, not gating).
- No coverage gap.

### Beat 4 - Ask for the fix (~90s)

Prompt (paste or paraphrase):

```
usabl flagged a blocking accessibility barrier on this change: the decorative image with no
alternative text on the users page in platform/access/users/components/PlatformUsersList.tsx.
Mark it decorative with an empty alt so screen readers skip it. Re-run usabl check when done.
```

You can also type `/usabl-fix` if that skill is installed. Scope the ask to the **image only**: do
not ask the agent to fix the nav contrast, which is recorded debt and would open a coverage gap.
Either way, let the agent edit source. Do **not** run `npm run demo:film:repair` yourself on camera
unless the agent is stuck; that script removes the image barrier for recovery and leaves the nav at
floor. The point is the agent applies the real fix.

### Beat 5 - Stop hook blocks (~60s)

When the agent says it is done, let the turn complete. The **stop hook** should fire and loop the
agent back with a block message listing the gating barrier (the image-alt regression).

If it allows instead:

- Confirm `USABL_STORAGE_STATE` is set in the Cursor environment.
- Confirm `.cursor/hooks.json` exists and `hooks/usabl-stop.sh` is executable.
- Run `npm run demo:film:status` and confirm `users-break=yes` and `nav=broken` if the agent has
  not fixed anything yet.

Narrate: "The assistant cannot certify its own work. The gate blocks the first stop."

### Beat 6 - Finish the repair (~60s)

The agent adds the empty `alt` and re-runs the check. Type `/usabl-check` again to confirm. Expect
**VERIFIED**, exit 0, nothing blocking, 29 recorded, and **no coverage gap**. Let the agent stop
again; the hook should **allow**.

If the check still reports a gap naming `PageNavigation.tsx`, the agent also touched the nav
contrast. Ask it to revert that and keep only the `alt` fix, then re-check.

Optional terminal proof:

```
cd /home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo
USABL_STORAGE_STATE=/home/eparenti/work/repos/innovation-days-2026/aui-session-live.json \
  node /home/eparenti/work/repos/innovation-days-2026/usabl/dist/cli.js check
```

### Beat 7 - Overlay after fix (~30s)

Reload `http://localhost:4100/access/users`. The header returns to **Verified**, 29 recorded, and
the injected image no longer flags an image-alt barrier. The Automation Hub contrast finding is
still present as recorded debt: the blocking regression the agent introduced is gone, while the
pre-existing debt the team chose not to fix today is still tracked, not silently dropped.

---

## After filming

```
cd /home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo
npm run demo:film:reset
git checkout -- .
```

Commit the repair only if you want it on `devel`. The film scripts are safe to keep.

---

## Quick recovery

| Symptom | Fix |
| --- | --- |
| Sign-in page instead of Users | Use `localhost:4100`, remint session, log in again |
| `not_covered` / connection refused | Rerun `start-demo.sh`, remint session |
| Overlay idle | Hard refresh; confirm dev server on 4100 |
| Stop hook silent | `usabl install --cursor`, `chmod +x .cursor/hooks/usabl-stop.sh`, restart Cursor with `USABL_STORAGE_STATE` |
| Scan takes forever | Do not edit `vite.config.ts`; cut away during the 90s scan |
| Agent fixed via npm script | Cut that take; prompt it to edit source instead |
| `not_covered` naming `PageNavigation.tsx` | Agent also fixed the nav contrast. Ask it to revert that and keep only the `alt` fix; the contrast is debt you leave alone |

## What changed in source (for your notes)

**Film break** (`PlatformUsersList.tsx`): 1x1 decorative `<img>` with no `alt` (the new regression
the stop hook blocks). The agent's fix is an empty `alt=""` marking it decorative.

**Coverage mapping** (`usabl.config.json`, committed on `devel`): the `users` surface `files` list
includes `platform/access/users/components/PlatformUsersList.tsx`, so the agent's fix on that
component is attributed to the users surface and the run reaches VERIFIED. Without this mapping the
fix returns NOT COVERED and the agent cannot clear the gate.

**Nav contrast** (`framework/PageNavigation/PageNavigation.tsx`): left at `opacity: 0.5` (recorded
floor debt). Not fixed on camera. Fixing it would edit this framework file, mapped to no surface,
and open a fresh `not_covered` gap.
