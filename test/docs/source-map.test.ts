import { describe, expect, it } from "vitest";
import type { Draft, FsGlob } from "../../src/contracts/index.js";
import { mapFindingToSource } from "../../src/docs/source-map.js";

// A fake reader over an in-memory file map. Any path not present returns null, which is how
// the real FsGlob.readFile signals a missing file, so source mapping must fail open, never throw.
function fakeFs(files: Record<string, string>): Pick<FsGlob, "readFile"> {
  return {
    async readFile(p: string): Promise<string | null> {
      return Object.prototype.hasOwnProperty.call(files, p)
        ? (files[p] as string)
        : null;
    },
  };
}

// A minimal deterministic-fail Draft. Tests override only the fields that matter to the case,
// so an assertion on the mapping is never confused by unrelated finding fields.
function draft(over: Partial<Draft>): Draft {
  return {
    rule: "image-alt",
    layer: "axe",
    severity: "serious",
    evidenceClass: "deterministic",
    screenId: "clusters",
    elementPath: "img",
    elementName: null,
    role: null,
    whatUserExperiences: "Image has no text alternative.",
    why: "A screen reader announces nothing for this image.",
    fix: "generic finding fix",
    evidence: {},
    confidence: "fail",
    ...over,
  };
}

describe("mapFindingToSource", () => {
  describe("images (alt text)", () => {
    it("names the image:: macro and phrases an AsciiDoc alt-text fix", async () => {
      const files = {
        "assemblies/assembly_clusters.adoc":
          "= Clusters\n\ninclude::../modules/proc_create.adoc[]\n",
        "modules/proc_create.adoc":
          "== Create a cluster\n\nimage::create-cluster.png[]\n",
      };
      const closure = {
        assemblyFile: "assemblies/assembly_clusters.adoc",
        sources: [
          "assemblies/assembly_clusters.adoc",
          "modules/proc_create.adoc",
        ],
      };
      const finding = draft({
        rule: "image-alt",
        evidence: { extra: { html: '<img src="create-cluster.png">' } },
      });

      const mapping = await mapFindingToSource(finding, closure, fakeFs(files));

      expect(mapping.tier).toBe("content");
      expect(mapping.file).toBe("modules/proc_create.adoc");
      expect(mapping.candidates).toEqual(["modules/proc_create.adoc"]);
      expect(mapping.construct).toBe("image::create-cluster.png");
      expect(mapping.line).toBeNull();
      // The fix must be phrased in the author's own markup, not a DOM selector or axe rule id.
      expect(mapping.fix).toContain("image::create-cluster.png[");
      expect(mapping.fix).not.toContain("image-alt");
    });

    it("matches on the filename even when the source path carries a directory prefix", async () => {
      const files = {
        "modules/proc_create.adoc":
          "== Create\n\nimage::../images/create-cluster.png[Existing but empty]\n",
      };
      const closure = {
        assemblyFile: "modules/proc_create.adoc",
        sources: ["modules/proc_create.adoc"],
      };
      const finding = draft({
        rule: "image-alt",
        // The rendered DOM src is the resolved basename, the source uses a relative path.
        evidence: { extra: { html: '<img src="create-cluster.png" alt="">' } },
      });

      const mapping = await mapFindingToSource(finding, closure, fakeFs(files));

      expect(mapping.tier).toBe("content");
      expect(mapping.file).toBe("modules/proc_create.adoc");
      expect(mapping.construct).toBe("image::../images/create-cluster.png");
    });

    it("discloses every candidate when the same image appears in more than one module", async () => {
      const files = {
        "modules/a.adoc": "image::shared.png[]\n",
        "modules/b.adoc": "image::shared.png[]\n",
      };
      const closure = {
        assemblyFile: "assemblies/assembly.adoc",
        // Deliberately unsorted to prove the module sorts candidates for a stable primary.
        sources: [
          "modules/b.adoc",
          "modules/a.adoc",
          "assemblies/assembly.adoc",
        ],
      };
      const finding = draft({
        rule: "image-alt",
        evidence: { extra: { html: '<img src="shared.png">' } },
      });

      const mapping = await mapFindingToSource(finding, closure, fakeFs(files));

      expect(mapping.tier).toBe("content");
      // Ambiguous ownership is disclosed, not guessed away.
      expect(mapping.candidates).toEqual(["modules/a.adoc", "modules/b.adoc"]);
      // The primary is the first candidate in stable order.
      expect(mapping.file).toBe("modules/a.adoc");
      // A construct that is not unique cannot claim a line.
      expect(mapping.line).toBeNull();
    });

    it("falls back to the assembly file when the image is in no source in the closure", async () => {
      const files = {
        "modules/proc_create.adoc": "image::something-else.png[Alt]\n",
      };
      const closure = {
        assemblyFile: "assemblies/assembly_clusters.adoc",
        sources: [
          "assemblies/assembly_clusters.adoc",
          "modules/proc_create.adoc",
        ],
      };
      const finding = draft({
        rule: "image-alt",
        evidence: { extra: { html: '<img src="ghost.png">' } },
      });

      const mapping = await mapFindingToSource(finding, closure, fakeFs(files));

      expect(mapping.tier).toBe("fallback");
      expect(mapping.file).toBe("assemblies/assembly_clusters.adoc");
      expect(mapping.construct).toBeNull();
      // Fallback discloses the whole closure as the candidate set, never a false-precise single file.
      expect(mapping.candidates).toEqual([
        "assemblies/assembly_clusters.adoc",
        "modules/proc_create.adoc",
      ]);
    });
  });

  describe("links (name / text quality)", () => {
    it("locates the link by href and suggests descriptive link text in AsciiDoc", async () => {
      const files = {
        "modules/con_overview.adoc":
          "== Overview\n\nSee link:https://example.com/docs[] for the full reference.\n",
      };
      const closure = {
        assemblyFile: "modules/con_overview.adoc",
        sources: ["modules/con_overview.adoc"],
      };
      const finding = draft({
        rule: "link-name",
        elementPath: "a",
        evidence: {
          extra: { html: '<a href="https://example.com/docs"></a>' },
        },
      });

      const mapping = await mapFindingToSource(finding, closure, fakeFs(files));

      expect(mapping.tier).toBe("content");
      expect(mapping.file).toBe("modules/con_overview.adoc");
      expect(mapping.construct).toContain("https://example.com/docs");
      // The fix teaches the AsciiDoc link form with descriptive text, not a DOM fix.
      expect(mapping.fix).toContain("[");
      expect(mapping.fix.toLowerCase()).toContain("link");
    });
  });

  describe("headings (structure)", () => {
    it('finds the heading line by its text and phrases the level fix in "=" markers', async () => {
      const files = {
        "modules/con_overview.adoc":
          "== Overview\n\n==== Advanced options\n\nText.\n",
      };
      const closure = {
        assemblyFile: "modules/con_overview.adoc",
        sources: ["modules/con_overview.adoc"],
      };
      const finding = draft({
        rule: "docs-heading-order",
        layer: "docs-content",
        elementName: "Advanced options",
        role: "heading",
        evidence: { extra: { fromLevel: 2, toLevel: 4 } },
        fix: "Use the next heading level down instead of skipping one.",
      });

      const mapping = await mapFindingToSource(finding, closure, fakeFs(files));

      expect(mapping.tier).toBe("content");
      expect(mapping.file).toBe("modules/con_overview.adoc");
      expect(mapping.construct).toBe("==== Advanced options");
      // fromLevel 2 means the deepest allowed next level is 3, i.e. three "=" markers.
      expect(mapping.fix).toContain("=== Advanced options");
    });
  });

  describe("renderer sourcemap (tier 1)", () => {
    it("trusts data-source-file and data-source-line for an exact location", async () => {
      const closure = {
        assemblyFile: "assemblies/assembly.adoc",
        sources: ["assemblies/assembly.adoc", "modules/proc_create.adoc"],
      };
      const finding = draft({
        rule: "image-alt",
        evidence: {
          extra: {
            html: '<img src="create-cluster.png" data-source-file="modules/proc_create.adoc" data-source-line="42">',
          },
        },
      });

      // No fs is consulted for a renderer hit, so an empty reader still yields an exact map.
      const mapping = await mapFindingToSource(finding, closure, fakeFs({}));

      expect(mapping.tier).toBe("renderer");
      expect(mapping.file).toBe("modules/proc_create.adoc");
      expect(mapping.line).toBe(42);
      expect(mapping.candidates).toEqual(["modules/proc_create.adoc"]);
    });
  });

  describe("robustness", () => {
    it("fails open to a fallback when the finding carries no usable element content", async () => {
      const closure = {
        assemblyFile: "assemblies/assembly.adoc",
        sources: ["assemblies/assembly.adoc"],
      };
      const finding = draft({
        rule: "color-contrast",
        elementPath: ".chrome",
        evidence: {},
      });

      const mapping = await mapFindingToSource(finding, closure, fakeFs({}));

      expect(mapping.tier).toBe("fallback");
      expect(mapping.file).toBe("assemblies/assembly.adoc");
      expect(mapping.construct).toBeNull();
      expect(mapping.fix).toBe("generic finding fix");
    });

    it("does not throw when a source file cannot be read", async () => {
      const closure = {
        assemblyFile: "assemblies/assembly.adoc",
        sources: ["assemblies/assembly.adoc", "modules/missing.adoc"],
      };
      const finding = draft({
        rule: "image-alt",
        evidence: { extra: { html: '<img src="x.png">' } },
      });

      const mapping = await mapFindingToSource(finding, closure, fakeFs({}));

      expect(mapping.tier).toBe("fallback");
      expect(mapping.file).toBe("assemblies/assembly.adoc");
    });
  });
});
