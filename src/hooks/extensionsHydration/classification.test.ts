import { describe, expect, it } from "vitest";
import { filterExtensionSummariesByProject } from "./classification";

describe("filterExtensionSummariesByProject", () => {
  it("keeps global extensions and only the active project's local extensions", () => {
    const filtered = filterExtensionSummariesByProject(
      [
        { name: "user-ext", source: "directory" },
        {
          name: "mold:image-gallery",
          source: "project-directory",
          projectRoot: "/repo/mold",
        },
        {
          name: "latent:tools",
          source: "project-directory",
          projectRoot: "/repo/latentforge",
        },
      ],
      "/repo/latentforge",
    );

    expect(filtered.map((e) => e.name)).toEqual(["user-ext", "latent:tools"]);
  });

  it("drops project extensions when no active project path is known", () => {
    const filtered = filterExtensionSummariesByProject(
      [
        { name: "user-ext", source: "directory" },
        {
          name: "mold:image-gallery",
          source: "project-directory",
          projectRoot: "/repo/mold",
        },
      ],
      null,
    );

    expect(filtered.map((e) => e.name)).toEqual(["user-ext"]);
  });

  it("does not treat sibling path prefixes as the same project", () => {
    const filtered = filterExtensionSummariesByProject(
      [
        {
          name: "mold:image-gallery",
          source: "project-directory",
          projectRoot: "/repo/mold",
        },
      ],
      "/repo/mold-tools",
    );

    expect(filtered).toEqual([]);
  });
});
