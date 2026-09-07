/**
 * The session resolver decides whether a run scans signed in or signed out, so its rules are
 * held here directly rather than only through buildDeps. Three of them are honesty rules: an
 * empty variable is not a session, a path usabl cannot read stops the run instead of quietly
 * producing a signed-out scan that still mints a verdict (issue #152), and a session whose
 * cookies have all expired stops it for the same reason. Messages are asserted to exclude the
 * path, because the path can name a private location and the file it names holds live session
 * tokens.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isStorageStateExpired,
  readStorageStateEnv,
  resolveStorageStatePath,
  STORAGE_STATE_ENV_VAR,
} from "../../src/deps/session.js";

const VALID_STORAGE_STATE = JSON.stringify({ cookies: [], origins: [] });

// A fixed instant to judge expiry against, so the rule is not tested against the wall clock.
const NOW_MS = Date.UTC(2026, 8, 7, 12, 0, 0);
const NOW_SECONDS = NOW_MS / 1000;

function cookie(expires: number): Record<string, unknown> {
  return {
    name: "session",
    value: "not-a-real-token",
    domain: "app.test",
    path: "/",
    expires,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  };
}

describe("readStorageStateEnv", () => {
  it("reads a configured path", () => {
    expect(
      readStorageStateEnv({ [STORAGE_STATE_ENV_VAR]: "/tmp/session.json" }),
    ).toBe("/tmp/session.json");
  });

  it("trims surrounding whitespace a shell export can leave behind", () => {
    expect(
      readStorageStateEnv({ [STORAGE_STATE_ENV_VAR]: "  /tmp/session.json\n" }),
    ).toBe("/tmp/session.json");
  });

  it("treats an unset, empty, or whitespace-only value as no session", () => {
    expect(readStorageStateEnv({})).toBeNull();
    expect(readStorageStateEnv({ [STORAGE_STATE_ENV_VAR]: "" })).toBeNull();
    expect(readStorageStateEnv({ [STORAGE_STATE_ENV_VAR]: "   " })).toBeNull();
  });
});

describe("resolveStorageStatePath", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "usabl-session-resolve-"));
    statePath = join(dir, "storage-state.json");
    await writeFile(statePath, VALID_STORAGE_STATE, "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the environment path when the file reads and parses", async () => {
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: statePath } }),
    ).resolves.toBe(statePath);
  });

  it("returns null when no session is configured", async () => {
    await expect(resolveStorageStatePath({ env: {} })).resolves.toBeNull();
  });

  it("lets an explicit caller path win over the environment", async () => {
    // Load-bearing: measurement scripts pass a session directly, and a stray variable in the
    // operator's shell must not redirect a script that was told which session to use.
    await expect(
      resolveStorageStatePath({
        explicit: "/tmp/explicit-session.json",
        env: { [STORAGE_STATE_ENV_VAR]: statePath },
      }),
    ).resolves.toBe("/tmp/explicit-session.json");
  });

  it("throws when the environment path cannot be read, and never prints it", async () => {
    const missing = join(dir, "absent-session.json");
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: missing } }),
    ).rejects.toThrow(STORAGE_STATE_ENV_VAR);
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: missing } }),
    ).rejects.not.toThrow(missing);
  });

  it("throws when the environment path is not JSON, and never quotes the contents", async () => {
    const junkPath = join(dir, "not-json.json");
    await writeFile(junkPath, "cookie=letmein", "utf8");
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: junkPath } }),
    ).rejects.toThrow(/not JSON/);
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: junkPath } }),
    ).rejects.not.toThrow(/letmein/);
  });

  it("throws when the file holds nothing that could authenticate, and says to mint a new session", async () => {
    // The cheap half of the expired-session fix. The file reads and parses, so nothing upstream
    // objects, but every cookie is dated, every date is past, and there is no local storage, so
    // there is nothing left in it that could work. Stopping here costs one file read and never
    // opens a browser, and the run mints no verdict at all.
    const deadPath = join(dir, "dead-session.json");
    await writeFile(
      deadPath,
      JSON.stringify({
        cookies: [cookie(NOW_SECONDS - 3_600), cookie(NOW_SECONDS - 60)],
        origins: [],
      }),
      "utf8",
    );

    const attempt = (): Promise<string | null> =>
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: deadPath }, now: NOW_MS });

    await expect(attempt()).rejects.toThrow(/session has expired/);
    await expect(attempt()).rejects.toThrow(/[Mm]int a new session/);
    await expect(attempt()).rejects.toThrow(STORAGE_STATE_ENV_VAR);
    // Same rule as every other message here: no path and no cookie value.
    await expect(attempt()).rejects.not.toThrow(deadPath);
    await expect(attempt()).rejects.not.toThrow(/not-a-real-token/);
  });

  it("accepts a wall of expired cookies when local storage still holds something", async () => {
    // The false refusal this must never make. A bearer token in local storage carries no expiry,
    // so nothing about those cookie dates says the session is dead. Refusing here would stop a
    // working run for no reason, and a false refusal has no backstop; a missed dead session is
    // caught at scan time by the rules that measure the page.
    const tokenPath = join(dir, "local-storage-session.json");
    await writeFile(
      tokenPath,
      JSON.stringify({
        cookies: [cookie(NOW_SECONDS - 3_600), cookie(NOW_SECONDS - 60)],
        origins: [{ origin: "http://app.test", localStorage: [{ name: "jwt", value: "letmein" }] }],
      }),
      "utf8",
    );
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: tokenPath }, now: NOW_MS }),
    ).resolves.toBe(tokenPath);
  });

  it("accepts a session cookie sitting beside expired dated cookies", async () => {
    // A session cookie dies with the browser and states no expiry, so it could still be the one
    // carrying the session. One of them makes the whole file unjudgeable.
    const mixedPath = join(dir, "mixed-session.json");
    await writeFile(
      mixedPath,
      JSON.stringify({ cookies: [cookie(-1), cookie(NOW_SECONDS - 3_600)], origins: [] }),
      "utf8",
    );
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: mixedPath }, now: NOW_MS }),
    ).resolves.toBe(mixedPath);
  });

  it("accepts a session with one cookie still in date", async () => {
    const livePath = join(dir, "live-session.json");
    await writeFile(
      livePath,
      JSON.stringify({ cookies: [cookie(NOW_SECONDS - 60), cookie(NOW_SECONDS + 3_600)], origins: [] }),
      "utf8",
    );
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: livePath }, now: NOW_MS }),
    ).resolves.toBe(livePath);
  });

  it("accepts a session of nothing but session cookies, which carry no expiry to judge", async () => {
    const sessionOnlyPath = join(dir, "session-cookies.json");
    await writeFile(
      sessionOnlyPath,
      JSON.stringify({ cookies: [cookie(-1), cookie(-1)], origins: [] }),
      "utf8",
    );
    await expect(
      resolveStorageStatePath({ env: { [STORAGE_STATE_ENV_VAR]: sessionOnlyPath }, now: NOW_MS }),
    ).resolves.toBe(sessionOnlyPath);
  });
});

describe("isStorageStateExpired", () => {
  it("refuses only when every cookie is dated and every date is past", () => {
    expect(isStorageStateExpired({ cookies: [cookie(NOW_SECONDS - 1)] }, NOW_MS)).toBe(true);
    expect(isStorageStateExpired({ cookies: [cookie(NOW_SECONDS)] }, NOW_MS)).toBe(true);
    expect(
      isStorageStateExpired({ cookies: [cookie(NOW_SECONDS - 1), cookie(NOW_SECONDS - 2)] }, NOW_MS),
    ).toBe(true);
    expect(isStorageStateExpired({ cookies: [cookie(NOW_SECONDS + 1)] }, NOW_MS)).toBe(false);
    expect(
      isStorageStateExpired({ cookies: [cookie(NOW_SECONDS - 1), cookie(NOW_SECONDS + 1)] }, NOW_MS),
    ).toBe(false);
  });

  it("never refuses when one cookie carries no usable expiry", () => {
    // A negative value is Playwright's session-cookie marker. Zero, a missing field, and a value
    // that is not a number all state no expiry, so any one of them could still be carrying the
    // session and makes the whole file unjudgeable. This is the case an earlier version of this
    // rule got wrong: it skipped those cookies and refused on the dated ones beside them.
    expect(isStorageStateExpired({ cookies: [cookie(-1)] }, NOW_MS)).toBe(false);
    expect(isStorageStateExpired({ cookies: [cookie(0)] }, NOW_MS)).toBe(false);
    expect(isStorageStateExpired({ cookies: [{ name: "s", value: "v" }] }, NOW_MS)).toBe(false);
    expect(
      isStorageStateExpired({ cookies: [cookie(-1), cookie(NOW_SECONDS - 1)] }, NOW_MS),
    ).toBe(false);
    expect(
      isStorageStateExpired({ cookies: [{ name: "s", value: "v" }, cookie(NOW_SECONDS - 1)] }, NOW_MS),
    ).toBe(false);
  });

  it("never refuses when any origin still holds local storage", () => {
    // A bearer or refresh token is recorded there as an opaque name and value with no expiry
    // field, so its presence is a thing that might still authenticate.
    const expired = [cookie(NOW_SECONDS - 1)];
    expect(
      isStorageStateExpired(
        { cookies: expired, origins: [{ origin: "http://app.test", localStorage: [{ name: "jwt", value: "x" }] }] },
        NOW_MS,
      ),
    ).toBe(false);
    // An origin entry holding nothing is not something that could authenticate, so it does not
    // block the refusal.
    expect(
      isStorageStateExpired(
        { cookies: expired, origins: [{ origin: "http://app.test", localStorage: [] }] },
        NOW_MS,
      ),
    ).toBe(true);
    // An origins field in a shape this does not understand is treated as holding something.
    expect(isStorageStateExpired({ cookies: expired, origins: "some" }, NOW_MS)).toBe(false);
    expect(isStorageStateExpired({ cookies: expired, origins: [null] }, NOW_MS)).toBe(false);
  });

  it("says nothing about a state with no cookies at all", () => {
    expect(isStorageStateExpired({ cookies: [], origins: [] }, NOW_MS)).toBe(false);
    expect(isStorageStateExpired({ origins: [] }, NOW_MS)).toBe(false);
  });

  it("rejects a clock that is not a finite number of milliseconds", () => {
    // Infinity would put every expiry in the past and refuse every session. NaN would fail every
    // comparison and accept every session. Both are programmer errors in the caller's clock and
    // neither may be answered with a boolean.
    const dead = { cookies: [cookie(NOW_SECONDS - 1)], origins: [] };
    const live = { cookies: [cookie(NOW_SECONDS + 1)], origins: [] };
    for (const clock of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      expect(() => isStorageStateExpired(dead, clock)).toThrow(TypeError);
      expect(() => isStorageStateExpired(live, clock)).toThrow(TypeError);
    }
  });

  it("says nothing about a shape it does not recognise", () => {
    expect(isStorageStateExpired(null, NOW_MS)).toBe(false);
    expect(isStorageStateExpired("cookies", NOW_MS)).toBe(false);
    expect(isStorageStateExpired({ cookies: "none" }, NOW_MS)).toBe(false);
    expect(isStorageStateExpired({ cookies: [null, 7] }, NOW_MS)).toBe(false);
  });
});
