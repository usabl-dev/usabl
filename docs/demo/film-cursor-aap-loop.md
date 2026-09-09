# Film script: `/usabl-check` + stop hook on ansible-ui-demo

One take, about 8 to 12 minutes. You type the prompts; the agent does the code. The contrast
finding on **Automation Hub** is the hero fix. The stop hook needs a **new** regression, so the
script injects one on the users screen first, then you fix both.

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
6. Optional one-liner: "Recorded debt does not block, but the inspector still shows what to fix."

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
- The Hub contrast finding should still appear.
- The new **image-alt** finding on the users screen should appear.

### Beat 4 - Ask for the fix (~3 min)

Prompt (paste or paraphrase):

```
Fix the accessibility barriers usabl flagged on this change: the Automation Hub nav subtitle
contrast in framework/PageNavigation/PageNavigation.tsx, and the decorative image on the users
page in platform/access/users/components/PlatformUsersList.tsx. Use PatternFly subtle text
color for the subtitle instead of opacity. Re-run usabl check when done.
```

You can also type `/usabl-fix` if that skill is installed. Either way, let the agent edit source.

Do **not** run `npm run demo:film:repair` yourself on camera unless the agent is stuck. The point
is the agent applies the real fix.

### Beat 5 - Stop hook blocks (~60s)

When the agent says it is done, let the turn complete. The **stop hook** should fire and loop the
agent back with a block message listing gating barriers (image-alt and/or contrast).

If it allows instead:

- Confirm `USABL_STORAGE_STATE` is set in the Cursor environment.
- Confirm `.cursor/hooks.json` exists and `hooks/usabl-stop.sh` is executable.
- Run `npm run demo:film:status` and confirm `users-break=yes` and `nav=broken` if the agent has
  not fixed anything yet.

Narrate: "The assistant cannot certify its own work. The gate blocks the first stop."

### Beat 6 - Finish the repair (~2 min)

If the agent only fixed one barrier, prompt:

```
usabl still reports a regression. Fix the remaining blocking finding and run usabl check again.
```

When both are fixed, type `/usabl-check` again. Expect **VERIFIED**, nothing blocking. Let the
agent stop again; the hook should **allow**.

Optional terminal proof:

```
cd /home/eparenti/work/repos/innovation-days-2026/ansible-ui-demo
USABL_STORAGE_STATE=/home/eparenti/work/repos/innovation-days-2026/aui-session-live.json \
  node /home/eparenti/work/repos/innovation-days-2026/usabl/dist/cli.js check
```

### Beat 7 - Overlay after fix (~30s)

Reload `http://localhost:4100/access/users`. The Hub contrast finding should be gone from the
live scan (recorded count drops). Highlight on Hub should no longer show a contrast failure.

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

## What changed in source (for your notes)

**Contrast fix** (`framework/PageNavigation/PageNavigation.tsx`):

- Before: `opacity: 0.5` on nav subtitles (fails WCAG AA on Hub, AWX, EDA).
- After: `color: var(--pf-t--global--text--color--subtle)` (matches other screens in this repo).

**Film break** (`PlatformUsersList.tsx`): 1x1 decorative `<img>` with no `alt` (new regression).
