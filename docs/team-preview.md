# Team preview runbook

This is the internal loop for usabl v0.1.0. A teammate, without Ed in the room, can clone both repos, feel the hero bug, see the gated result on four surfaces, fix it in code, and watch the ratchet go to verified.

## Layout

```
<parent>/
  usabl/        engine (this repo)
  usabl-app/    fixture (PatternFly 6 app)
```

Clone both as siblings from the `usabl-dev` org. The fixture depends on the engine with `"usabl": "file:../usabl"`.

```bash
git clone https://github.com/usabl-dev/usabl.git
git clone https://github.com/usabl-dev/usabl-app.git
```

Both repos are private. Ask a maintainer for access if clone fails.

## Setup

1. Node 22. Clone both repos as siblings (URLs above). `npm install` in each.
2. In `usabl`: `npm run build` (produces dist/ with CLI, overlay plugin, stop-hook runner).
3. In `usabl-app`: `npm run dev` starts on `http://127.0.0.1:5173`.

## The loop

1. Browser: go to `/clusters`. The trigger is "View cluster details" with `aria-haspopup="dialog"`. Open the modal, press Escape: focus is lost (does not return to the button).
2. From `usabl-app` directory: `npx usabl check`. Expect `regression`, rule `pf-modal-focus-return`, exit code 1, no receipt.
3. Overlay: the badge in the running app shows that same result. `?usabl=off` hides it. Playwright sessions skip it automatically.
4. Stop hook: open an AI session on `usabl-app`. The stop hook blocks on regression (`{"decision":"block"}` on stdout). The assistant sees the finding and how to fix it.
5. Fix the modal: restore `triggerEl.focus()` on close. Re-run `usabl check`. Expect `verified` with a receipt.
6. Open a PR that touches `src/pages/Clusters.tsx` or the modal. Unfixed: the usabl check fails and a sticky PR comment shows the result. Fixed: VERIFIED.

## What each surface shows

| Surface | Gating | Notes |
| --- | --- | --- |
| CLI (`usabl check`) | yes, exit code | Main entrypoint |
| Overlay (Vite plugin) | no, advisory | Badge hides on `?usabl=off` or webdriver |
| Stop hook | yes, blocks AI | One block per continuation, then advisory |
| PR comment + CI | yes, check status | `--ci --trusted-ref` required |

## Feedback

File issues on the `usabl` repo using the Feedback template. Include: surface, verdict seen, expected verdict, repro steps, and whether the output was honest or confusing.

## What this is not

- Not the contest pitch or judge demo script.
- Not Fleet Insights live measurement. Not MCP.
- The query-string variant (`?variant=fixed`) is for automated oracles, not the team ratchet. Fix the code, not a URL parameter.
