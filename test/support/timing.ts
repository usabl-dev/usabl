/**
 * One budget for every test that waits on a real out-of-process thing: a spawned subprocess
 * (`npm run ...`) or a launched browser. These tests are the only ones whose outcome a busy
 * machine can change, because their clock is the wall clock, not a virtual one.
 *
 * The policy, decided once here rather than tuned per test:
 *   - A real-process test gets a budget generous enough that machine load cannot decide the
 *     outcome. The assertion (does it fail closed, does it wait for the right signal) is
 *     correct regardless of load; only the wall-clock ceiling ever caused a red, so the ceiling
 *     is set high enough that a full suite and a browser running alongside cannot reach it.
 *   - A pure-logic or fake-timer test keeps its default or virtual budget. `vi.useFakeTimers`
 *     advances a virtual clock, so those tests are immune to load and must not inherit this
 *     number; doing so would only hide a genuine hang behind a long timeout.
 *
 * If a real-process test ever needs a tighter budget on purpose, it says so at the test with
 * the reason, so the next person does not raise it blindly. The default is this shared value.
 *
 * The integration tests behind `USABL_INTEGRATION=1` (a real fixture server plus a browser
 * scan) do not run in the default suite and keep their own larger, deliberately chosen budgets,
 * because a full run() over a live app legitimately needs more headroom than a subprocess that
 * fails closed. That is the "tighter or looser on purpose, say so at the test" clause, not an
 * exception to the policy.
 *
 * The number is deliberately far above the few seconds these operations take when idle. A
 * genuine hang then costs this long to surface, which is the right trade for a handful of
 * out-of-process tests: a slow failure beats a flaky one in a suite whose whole product claim
 * is that a green result is proof.
 */
export const REAL_PROCESS_BUDGET_MS = 60_000;
