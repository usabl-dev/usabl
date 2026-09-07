import { execFile } from "node:child_process";
import { mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";
import {
  buildDeps,
  collectEngineFiles,
  hashEngineFiles,
  normalizeSeparators,
} from "../../src/deps/build.js";
import { testConfig } from "../helpers.js";

const packageJsonPath = fileURLToPath(
  new URL("../../package.json", import.meta.url),
);
const execFileAsync = promisify(execFile);

function readVersion(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value;
}

describe("buildDeps", () => {
  it("builds real Deps and keeps browser launch lazy", async () => {
    const launchSpy = vi.spyOn(chromium, "launch");

    try {
      const deps = await buildDeps(testConfig());
      expect(launchSpy).not.toHaveBeenCalled();
      expect(typeof deps.checkRunner.scan).toBe("function");
      expect(typeof deps.browser.open).toBe("function");
      expect(typeof deps.git.statusZ).toBe("function");
      expect(typeof deps.fs.glob).toBe("function");
      await deps.browser.close();
    } finally {
      launchSpy.mockRestore();
    }
  });

  it("reads runner and scanner versions for receipt metadata", async () => {
    const deps = await buildDeps(testConfig());
    const packageJson: unknown = JSON.parse(
      await readFile(packageJsonPath, "utf8"),
    );
    const packageVersion =
      typeof packageJson === "object" && packageJson !== null
        ? readVersion(Reflect.get(packageJson, "version"))
        : null;

    // runnerVersion binds the engine: package version plus a sha256 over the
    // on-disk engine files, so any engine change invalidates a prior receipt (ground-truth s10).
    expect(deps.runnerVersion.startsWith(`${packageVersion}+`)).toBe(true);
    expect(deps.runnerVersion).toMatch(/^.+\+[0-9a-f]{64}$/);
    expect(deps.scannerVersions.axeCore).toMatch(/\S+/);
    expect(deps.scannerVersions.playwright).toMatch(/\S+/);
    expect(deps.scannerVersions.chromium).toMatch(/\S+/);

    await deps.browser.close();
  });

  it("exposes the loaded requirement bundle for the docs surface", async () => {
    const deps = await buildDeps(testConfig());
    try {
      // No requirements directory is configured, so intake yields the empty bundle.
      // The docs surface reads this exact bundle instead of re-deriving intake itself.
      expect(deps.requirements).toEqual({ version: 1, requirements: [] });
    } finally {
      await deps.browser.close();
    }
  });

  it("uses cwd for git and filesystem adapters", async () => {
    const fixtureRepo = await mkdtemp(join(tmpdir(), "usabl-builddeps-"));
    await execFileAsync("git", ["init"], { cwd: fixtureRepo });
    await writeFile(join(fixtureRepo, "cwd-marker.txt"), "cwd-ok", "utf8");

    const deps = await buildDeps(testConfig(), { cwd: fixtureRepo });
    try {
      await expect(deps.fs.readFile("cwd-marker.txt")).resolves.toBe("cwd-ok");
      await expect(deps.git.statusZ()).resolves.toContainEqual({
        code: "??",
        path: "cwd-marker.txt",
      });
    } finally {
      await deps.browser.close();
      await rm(fixtureRepo, { recursive: true, force: true });
    }
  });

  it("carries USABL_STORAGE_STATE into the browser context it opens", async () => {
    // The defect this locks: the adapter accepts a storage state, but no operator entry
    // point supplied one, so a login-gated application was scanned signed out and the
    // engine measured blank pages. The assertion sits at the seam that decides it, the
    // Playwright context options, so it holds for every surface that funnels through
    // buildDeps. The fake browser records those options and then stops, because the
    // question is what the context was asked for, not what the page rendered.
    const sessionDir = await mkdtemp(join(tmpdir(), "usabl-session-env-"));
    const storageStatePath = join(sessionDir, "storage-state.json");
    await writeFile(
      storageStatePath,
      JSON.stringify({ cookies: [], origins: [] }),
      "utf8",
    );
    const contextOptions: Array<Record<string, unknown>> = [];
    const launchSpy = vi.spyOn(chromium, "launch").mockResolvedValue({
      newContext: async (options: Record<string, unknown>) => {
        contextOptions.push(options);
        throw new Error("context options recorded");
      },
      // A live process. The driver checks this before reusing a browser and after a failed open,
      // so the fake has to answer it like a real one.
      isConnected: () => true,
      close: async () => {},
    } as unknown as Browser);
    vi.stubEnv("USABL_STORAGE_STATE", storageStatePath);

    try {
      const deps = await buildDeps(testConfig());
      await expect(
        deps.browser.open("http://127.0.0.1:5173/clusters"),
      ).rejects.toThrow("context options recorded");
      expect(contextOptions).toEqual([{ storageState: storageStatePath }]);
    } finally {
      vi.unstubAllEnvs();
      launchSpy.mockRestore();
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it("refuses to build Deps from an expired session, and opens no browser", async () => {
    // The dead-session refusal, held at the seam every operator surface funnels through. The
    // point is not only that it throws: it throws before anything constructs a browser driver,
    // so no Chromium starts and no page is opened against the application's sign-in wall. The
    // CLI turns this throw into exit 4 with the message and no verdict.
    const sessionDir = await mkdtemp(join(tmpdir(), "usabl-session-expired-"));
    const storageStatePath = join(sessionDir, "storage-state.json");
    const expiredSeconds = Math.floor(Date.now() / 1000) - 86_400;
    await writeFile(
      storageStatePath,
      JSON.stringify({
        cookies: [
          {
            name: "session",
            value: "stale-value",
            domain: "app.test",
            path: "/",
            expires: expiredSeconds,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
      "utf8",
    );
    const launchSpy = vi.spyOn(chromium, "launch");
    const browserFor = vi.fn(() => {
      throw new Error("a browser driver must never be built for a dead session");
    });
    vi.stubEnv("USABL_STORAGE_STATE", storageStatePath);

    try {
      await expect(buildDeps(testConfig(), { browserFor })).rejects.toThrow(
        /session has expired/,
      );
      expect(browserFor).not.toHaveBeenCalled();
      expect(launchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      launchSpy.mockRestore();
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it("accepts storageStatePath and keeps browser launch lazy", async () => {
    const launchSpy = vi.spyOn(chromium, "launch");
    const storageStatePath = "/tmp/fleet-insights-session.json";

    try {
      const deps = await buildDeps(testConfig(), { storageStatePath });
      expect(launchSpy).not.toHaveBeenCalled();
      expect(typeof deps.checkRunner.scan).toBe("function");
      await deps.browser.close();
    } finally {
      launchSpy.mockRestore();
    }
  });
});

describe("hashEngineFiles", () => {
  it("is deterministic and independent of input order", () => {
    const forward = [
      { path: "a.ts", content: "alpha" },
      { path: "b.ts", content: "beta" },
    ];
    const reversed = [
      { path: "b.ts", content: "beta" },
      { path: "a.ts", content: "alpha" },
    ];

    expect(hashEngineFiles(forward)).toBe(hashEngineFiles(reversed));
  });

  it("changes when any engine file content changes", () => {
    const base = [
      { path: "a.ts", content: "alpha" },
      { path: "b.ts", content: "beta" },
    ];
    const tampered = [
      { path: "a.ts", content: "alpha" },
      { path: "b.ts", content: "beta-tampered" },
    ];

    expect(hashEngineFiles(tampered)).not.toBe(hashEngineFiles(base));
  });

  it("changes when an engine file is renamed", () => {
    const base = [{ path: "src/run.ts", content: "engine" }];
    const renamed = [{ path: "src/run-moved.ts", content: "engine" }];

    expect(hashEngineFiles(renamed)).not.toBe(hashEngineFiles(base));
  });

  it("changes when an engine file is added or removed", () => {
    const base = [{ path: "a.ts", content: "alpha" }];
    const grown = [
      { path: "a.ts", content: "alpha" },
      { path: "b.ts", content: "beta" },
    ];

    expect(hashEngineFiles(grown)).not.toBe(hashEngineFiles(base));
  });

  it("returns a lowercase hex sha256 digest", () => {
    expect(hashEngineFiles([{ path: "a.ts", content: "alpha" }])).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

describe("normalizeSeparators", () => {
  // The engine hash keys on the relative path. `path.relative` emits `\` on win32,
  // so a receipt minted on Linux would falsely fail re-verification on Windows unless
  // the separator is normalized before hashing. We cannot exercise win32 `relative()`
  // from a POSIX test host, so the normalization is driven through this pure helper.
  it("converts backslash separators to forward slashes", () => {
    expect(normalizeSeparators("deps\\build.ts")).toBe("deps/build.ts");
    expect(normalizeSeparators("a\\b\\c.ts")).toBe("a/b/c.ts");
  });

  it("leaves forward-slash paths unchanged", () => {
    expect(normalizeSeparators("src/deps/build.ts")).toBe("src/deps/build.ts");
    expect(normalizeSeparators("build.ts")).toBe("build.ts");
  });
});

describe("collectEngineFiles", () => {
  it("hashes real on-disk files and changes when one mutates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usabl-engine-collect-"));
    try {
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "a.ts"), "alpha", "utf8");
      await writeFile(join(dir, "sub", "b.ts"), "beta", "utf8");

      const before = hashEngineFiles(await collectEngineFiles(dir, ".ts"));
      await writeFile(join(dir, "sub", "b.ts"), "beta-tampered", "utf8");
      const after = hashEngineFiles(await collectEngineFiles(dir, ".ts"));

      expect(after).not.toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("only collects files with the engine extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usabl-engine-ext-"));
    try {
      await writeFile(join(dir, "engine.ts"), "engine", "utf8");
      await writeFile(join(dir, "notes.md"), "ignored", "utf8");
      await writeFile(
        join(dir, "types.d.ts"),
        "declare const x: number;",
        "utf8",
      );

      const files = await collectEngineFiles(dir, ".ts");
      const paths = files.map((file) => file.path).sort();

      // `.d.ts` also ends with `.ts` today; the assertion pins current behavior so a
      // future extension filter change (e.g. excluding declarations) is a deliberate edit.
      expect(paths).toEqual(["engine.ts", "types.d.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports nested paths with forward slashes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usabl-engine-nested-"));
    try {
      await mkdir(join(dir, "nested"), { recursive: true });
      await writeFile(join(dir, "nested", "x.ts"), "x", "utf8");

      const files = await collectEngineFiles(dir, ".ts");

      expect(files.map((file) => file.path)).toEqual(["nested/x.ts"]);
      expect(files.every((file) => !file.path.includes("\\"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
