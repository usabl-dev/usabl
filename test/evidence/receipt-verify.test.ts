import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UsablConfig } from "../../src/contracts/index.js";
import { collectEngineFiles, hashEngineFiles } from "../../src/deps/build.js";
import { makeFakeDeps } from "../../src/deps/fakes.js";
import {
  computePolicyHash,
  mintReceipt,
  verifyReceipt,
} from "../../src/evidence/receipt.js";
import { buildGuardedSet, expandGuardedSet } from "../../src/trust/guard.js";

const config: UsablConfig = {
  appBaseUrl: "http://127.0.0.1:5173",
  uiFileGlobs: ["src/**/*.tsx"],
  discovery: { routerFile: "src/router.tsx", wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ["usabl.config.json", "src/gate"],
};

const mintArgs = {
  surfaces: ["cli"],
  checked: ["clusters"],
  notCovered: [],
  applicability: [],
  findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
  activeWaivers: 0,
};

const guardFiles = {
  "usabl.config.json": '{"guardedPaths":["src/gate"]}',
  "src/gate/index.ts": "safe",
};

const guardBlobs = {
  "usabl.config.json": "blob-config-a",
  "src/gate/index.ts": "blob-gate-a",
};

describe("verifyReceipt", () => {
  it("re-verifies a receipt minted from the expanded guarded set", async () => {
    const deps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: "tree-a",
      runnerVersion: "0.1.0",
    });

    const expanded = await expandGuardedSet(deps, buildGuardedSet(config));
    const receipt = await mintReceipt(
      deps,
      { ...config, guardedPaths: expanded },
      mintArgs,
    );

    expect(receipt.policyHash).toBe(await computePolicyHash(deps, expanded));
    await expect(
      verifyReceipt(deps, config, receipt, "tree-a"),
    ).resolves.toEqual({
      valid: true,
      failedFields: [],
    });
  });

  it("re-verifies a receipt minted from raw guarded config", async () => {
    const deps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: "tree-a",
      runnerVersion: "0.1.0",
    });

    const receipt = await mintReceipt(deps, config, mintArgs);
    const expanded = await expandGuardedSet(deps, buildGuardedSet(config));

    expect(receipt.policyHash).toBe(await computePolicyHash(deps, expanded));
    await expect(
      verifyReceipt(deps, config, receipt, "tree-a"),
    ).resolves.toEqual({
      valid: true,
      failedFields: [],
    });
  });

  it("does not compare applicability, because it is recorded, not certified", async () => {
    // Applicability is informational: it states what the run examined, and it legitimately
    // varies with app state (a dialog present one run, absent the next). If verify compared it,
    // an honest receipt would fail re-check whenever the page changed. So a receipt whose
    // applicability differs from a fresh run must still re-verify valid when the certified
    // fields (source tree, policy, runner, scanners) match.
    const deps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: "tree-a",
      runnerVersion: "0.1.0",
    });

    const receipt = await mintReceipt(deps, config, {
      ...mintArgs,
      applicability: [{ screenId: "clusters", applied: 40, abstained: 3 }],
    });
    const withDifferentApplicability = {
      ...receipt,
      applicability: [{ screenId: "clusters", applied: 12, abstained: 31 }],
    };

    await expect(
      verifyReceipt(deps, config, withDifferentApplicability, "tree-a"),
    ).resolves.toEqual({ valid: true, failedFields: [] });
  });

  it("fails only sourceTree when current source tree differs", async () => {
    const deps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: "tree-a",
      runnerVersion: "0.1.0",
    });

    const expanded = await expandGuardedSet(deps, buildGuardedSet(config));
    const receipt = await mintReceipt(
      deps,
      { ...config, guardedPaths: expanded },
      mintArgs,
    );

    await expect(
      verifyReceipt(deps, config, receipt, "tree-b"),
    ).resolves.toEqual({
      valid: false,
      failedFields: ["sourceTree"],
    });
  });

  it("fails policyHash when guarded blobs change at HEAD", async () => {
    const mintDeps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: "tree-a",
      runnerVersion: "0.1.0",
    });
    const verifyDeps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: { ...guardBlobs, "src/gate/index.ts": "blob-gate-b" },
      writeTree: "tree-a",
      runnerVersion: "0.1.0",
    });

    const expanded = await expandGuardedSet(mintDeps, buildGuardedSet(config));
    const receipt = await mintReceipt(
      mintDeps,
      { ...config, guardedPaths: expanded },
      mintArgs,
    );

    await expect(
      verifyReceipt(verifyDeps, config, receipt, "tree-a"),
    ).resolves.toEqual({
      valid: false,
      failedFields: ["policyHash"],
    });
  });

  it("fails runnerVersion when engine version differs", async () => {
    const mintDeps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: "tree-a",
      runnerVersion: "0.1.0",
    });
    const verifyDeps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: "tree-a",
      runnerVersion: "0.2.0",
    });

    const expanded = await expandGuardedSet(mintDeps, buildGuardedSet(config));
    const receipt = await mintReceipt(
      mintDeps,
      { ...config, guardedPaths: expanded },
      mintArgs,
    );

    await expect(
      verifyReceipt(verifyDeps, config, receipt, "tree-a"),
    ).resolves.toEqual({
      valid: false,
      failedFields: ["runnerVersion"],
    });
  });

  it("fails scannerVersions when the scanner stack differs", async () => {
    // scannerVersions is what actually decides the verdict (axe-core). Minting it but
    // never comparing it would let a swapped scanner re-verify an old receipt.
    const mintDeps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: "tree-a",
      runnerVersion: "0.1.0",
      scannerVersions: {
        axeCore: "4.13.0",
        playwright: "1.55.0",
        chromium: "revision-1200",
      },
    });
    const verifyDeps = makeFakeDeps({
      files: guardFiles,
      headContents: guardFiles,
      headBlobs: guardBlobs,
      writeTree: "tree-a",
      runnerVersion: "0.1.0",
      scannerVersions: {
        axeCore: "4.14.0",
        playwright: "1.55.0",
        chromium: "revision-1200",
      },
    });

    const expanded = await expandGuardedSet(mintDeps, buildGuardedSet(config));
    const receipt = await mintReceipt(
      mintDeps,
      { ...config, guardedPaths: expanded },
      mintArgs,
    );

    await expect(
      verifyReceipt(verifyDeps, config, receipt, "tree-a"),
    ).resolves.toEqual({
      valid: false,
      failedFields: ["scannerVersions"],
    });
  });
});

describe("receipt engine binding (end-to-end)", () => {
  it("fails runnerVersion when an on-disk engine file changes between mint and verify", async () => {
    // The headline claim: a change to a shipped engine file moves the fingerprint and
    // invalidates a prior receipt (ground-truth §10). This exercises the full chain -
    // real disk walk -> hash -> runnerVersion -> mint -> verify - not just a string swap.
    const dir = await mkdtemp(join(tmpdir(), "usabl-engine-binding-"));
    try {
      await mkdir(join(dir, "core"), { recursive: true });
      await writeFile(
        join(dir, "core", "gate.ts"),
        'export const gate = () => "verified";',
        "utf8",
      );

      const versionAtMint = `0.2.0+${hashEngineFiles(await collectEngineFiles(dir, ".ts"))}`;
      const mintDeps = makeFakeDeps({
        files: guardFiles,
        headContents: guardFiles,
        headBlobs: guardBlobs,
        writeTree: "tree-a",
        runnerVersion: versionAtMint,
      });
      const expanded = await expandGuardedSet(
        mintDeps,
        buildGuardedSet(config),
      );
      const receipt = await mintReceipt(
        mintDeps,
        { ...config, guardedPaths: expanded },
        mintArgs,
      );

      // Tamper with a shipped engine file, then rebuild runnerVersion the same way.
      await writeFile(
        join(dir, "core", "gate.ts"),
        'export const gate = () => "verified"; // patched',
        "utf8",
      );
      const versionAtVerify = `0.2.0+${hashEngineFiles(await collectEngineFiles(dir, ".ts"))}`;
      expect(versionAtVerify).not.toBe(versionAtMint);

      const verifyDeps = makeFakeDeps({
        files: guardFiles,
        headContents: guardFiles,
        headBlobs: guardBlobs,
        writeTree: "tree-a",
        runnerVersion: versionAtVerify,
      });
      await expect(
        verifyReceipt(verifyDeps, config, receipt, "tree-a"),
      ).resolves.toEqual({
        valid: false,
        failedFields: ["runnerVersion"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
