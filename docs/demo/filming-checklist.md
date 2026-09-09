# Filming checklist and surfaces tour

How to bring the demo up, what each surface shows, and what to say if something odd appears. Pairs with `start-demo.sh`, `mint-session.sh`, and `demo-script.md`. Paths below assume the layout `setup-ansible-ui-team.sh` creates under `WORKDIR` (default `~/usabl-team`): the engine at `WORKDIR/usabl` and the application at `WORKDIR/ansible-ui-demo`. Set `USABL_ENGINE` if the engine lives elsewhere.

Lab address, jump host, and key path are never committed. They live in `WORKDIR/demo.env`, which both scripts source. See `ansible-ui-team-setup.md` for the values.

## Before the camera rolls

1. Keep the machine quiet. No test suites, no builds, no other scans. Heavy load doubles scan times and can make timing-sensitive tests fail.
2. Do not edit any `vite.config.ts` before a timed scan. A config edit triggers a one-time dependency re-optimization that doubles the next scan.
3. Run `start-demo.sh` and wait for its `ready` line. After a reboot it reopens the tunnel, waits for the lab, starts the dev server, warms the application in a browser, and mints a session.
4. Run `mint-session.sh` right before each filmed brownfield scan. The gateway session cookie lives about 15 minutes. The dev server reads the same file on every scan, so no restart is needed. If the session dies mid-take, the engine reports not covered and names the refused request instead of scoring the sign-in page.
5. Log in with your own browser as well. The scanner's session and the viewer's session are separate. Signed out, the application shows the sign-in form at the scanned address while the panel still lists the last scan's findings, each marked as not on the page right now.
6. Expect about 90 seconds per brownfield scan. Most of it is the application loading its own module graph and the checks that prove menus do not steal focus. Film with a cut.

## Surface 1: the overlay

`http://localhost:4100/access/users`, with the overlay wired into `platform/vite.config.ts` of the demo application. The plugin is spread with `enforce: undefined` so it runs after the React plugin; its source-line injector runs before React by default and breaks JSX elements that carry generic type arguments, which this application has (engine issue 274). The overlay does not depend on the injector. The source-line hint is absent on this application either way, because the engine's source mapping is empty for it.

```ts
{ ...usablVitePluginFromConfig({ cwd: path.resolve(import.meta.dirname, '..') }), enforce: undefined },
```

- Verified while carrying debt: badge reads verified with 29 recorded findings, none blocking. Panel lead: "Nothing blocks this run." The findings sit under "Recorded, not blocking" with fixes offered as "How to fix it when you choose to". "Highlight it" and "Move focus to it" land on real elements once you are logged in.
- The overlay is per screen. Film on the screen the change maps to.
- To show a regression, inject a barrier with an identity of its own: an image without alternative text, or a form field without a label on a new element. Not another icon button. Count-based identities point at the pre-existing refresh control, which reads as the wrong element on camera.
- The panel header reads "usabl accessibility inspector".

## Surface 2: the terminal

From the application directory with `USABL_STORAGE_STATE` set to the session file:

```
node WORKDIR/usabl/dist/cli.js check
```

Verified while carrying debt:

```
usabl: VERIFIED (exit 0)
  No new barrier blocks this change. It can proceed.
  gate summary: verified: nothing blocking, 29 recorded
  recorded, not blocking: 29 finding(s)
    usabl already recorded these. They do not block this run.
```

An unchanged tree reports `NO VERDICT: IDLE (exit 0)`. A dead application URL is not a crash; it is not covered with a connection-refused gap. For a genuine no-verdict run, break the config file or remove the browser. Jump-to-source lines appear only on applications whose findings carry a source mapping.

## Surface 3: the stop hook and the self check

`usabl install --claude` and `usabl install --claude-skill` write the hook and the two skills into the application. If the application's `node_modules` does not contain `usabl`, point the hook command and the skills at the engine by path, because `npx usabl` would otherwise reach for the registry. The assistant session that triggers the hook needs `USABL_STORAGE_STATE` in its own environment.

Approval required says a code owner other than the author approves on the pull request, that nothing on the machine can approve it, that reverting an unintended change clears it, and that a person can run `usabl bypass` to let the assistant stop once.

## Surface 4: the pull request comment

The demo application cannot have a real CI check, because GitHub-hosted runners cannot reach the lab and the application needs its backend to render. The pull request beat is filmed on the small demo application's pull request, which runs the frozen engine in real CI: `usabl report: REGRESSION`, `deterministic: new 9 (9 failing, 0 unconfirmed)`, `blocked: yes`, every page-derived value in a code span inside the untrusted frame. Its checks: `gate-comment` red, `usabl-policy` green because no guarded path changed, `usabl-required` red as the check that decides. Do not push to or rebase that pull request before filming; any change re-runs it.

The noise budget shows five of eight rule groups and points at the rest. That is the feature, kept as is.

## Known limits, one breath each

- Always use `localhost:4100`, never `127.0.0.1:4100`. The minted session's cookies are scoped to the host name it was minted against, and a browser treats those two as different hosts even though both reach the same server. On `127.0.0.1` the application serves normally, the session signs nothing in, and the screen shows the sign-in form while `/api/gateway/v1/me/` answers 401.
- A barrier that lands in headroom the floor still records is counted as carried until `usabl floor prune` re-arms the floor; the tool says when that state exists.
- A verified run can carry recorded failures; verified means no new barrier blocks the change, not that the screen is clean.
- The engine observes that a barrier is no longer present; it does not witness the fix.
- A sign-in page with no refused request and no password field can still be scored; declare `reachedWhen` per surface on login-gated applications, naming content only that screen has.
- Route discovery matches raw text; a route with `element` before `path`, a commented-out route, or a path written as an expression can be missed. The routes sidecar takes precedence.
- A plain `usabl baseline` refuses when few screens are mapped against wide file globs; `usabl baseline --partial` writes a floor over the cleanly scanned screens.
