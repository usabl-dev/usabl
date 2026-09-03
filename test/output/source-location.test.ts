import { describe, expect, it } from "vitest";
import {
  editorDeepLink,
  formatAppSourceLocation,
} from "../../src/output/source-location.js";

describe("formatAppSourceLocation", () => {
  it("renders file and line for renderer-tier mappings", () => {
    expect(
      formatAppSourceLocation({
        tier: "renderer",
        file: "src/pages/Clusters.tsx",
        line: 12,
        candidates: ["src/pages/Clusters.tsx"],
      }),
    ).toBe("src/pages/Clusters.tsx:12");
  });
});

describe("editorDeepLink", () => {
  it("mints a vscode link only for renderer-tier mappings with a file", () => {
    expect(
      editorDeepLink("/workspace", {
        tier: "renderer",
        file: "src/pages/Clusters.tsx",
        line: 12,
        candidates: ["src/pages/Clusters.tsx"],
      }),
    ).toBe("vscode://file//workspace/src/pages/Clusters.tsx:12:1");
  });

  it("returns null for inferred coverage mappings even when a file is present", () => {
    expect(
      editorDeepLink("/workspace", {
        tier: "coverage",
        file: "fixtures/app/src/ClustersPage.tsx",
        line: null,
        candidates: ["fixtures/app/src/ClustersPage.tsx"],
      }),
    ).toBeNull();
  });

  it("returns null when coverage tier leaves file null and only candidates are known", () => {
    expect(
      editorDeepLink("/workspace", {
        tier: "coverage",
        file: null,
        line: null,
        candidates: [
          "fixtures/app/src/ClustersPage.tsx",
          "fixtures/app/src/DemoControls.tsx",
        ],
      }),
    ).toBeNull();
  });
});
