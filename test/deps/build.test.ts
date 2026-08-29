import { execFile } from "node:child_process";
import { mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
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
