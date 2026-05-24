import { describe, expect, it } from "vitest";
import {
  buildExtensionSidebarItems,
  filterExtensionSummariesByProject,
} from "./useExtensionsHydration";

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

    expect(filtered.map((e) => e.name)).toEqual([
      "user-ext",
      "latent:tools",
    ]);
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

describe("buildExtensionSidebarItems", () => {
  it("surfaces user, project, failed, and disabled extensions without the core layout", () => {
    const items = buildExtensionSidebarItems(
      [
        { name: "default-layout", source: "directory" },
        { name: "user-ext", source: "directory" },
        {
          name: "mold:gallery",
          source: "project-directory",
          projectRoot: "/repo/mold",
        },
        { name: "package-ext", source: "extension-package" },
      ],
      [
        {
          name: "broken-ext",
          source: "directory",
          error: "boom",
        },
      ],
      ["disabled-ext"],
      "/repo/mold",
    );

    expect(items).toEqual([
      {
        id: "ext:user-ext",
        label: "user-ext",
        hint: "user",
        active: true,
      },
      {
        id: "ext:mold:gallery",
        label: "mold:gallery",
        hint: "project",
        active: true,
      },
      {
        id: "ext:package-ext",
        label: "package-ext",
        hint: "package",
        active: true,
      },
      {
        id: "ext-failed:broken-ext",
        label: "broken-ext",
        hint: "user · failed",
        active: false,
      },
      {
        id: "ext-disabled:disabled-ext",
        label: "disabled-ext",
        hint: "disabled",
        active: false,
      },
    ]);
  });

  it("shows a restart hint when a newly disabled extension is still loaded", () => {
    const items = buildExtensionSidebarItems(
      [{ name: "user-ext", source: "directory" }],
      [],
      ["user-ext"],
    );

    expect(items).toEqual([
      {
        id: "ext-disabled:user-ext",
        label: "user-ext",
        hint: "disabled · restart",
        active: false,
      },
    ]);
  });

  it("filters project extensions to the active project", () => {
    const items = buildExtensionSidebarItems(
      [
        {
          name: "mold:gallery",
          source: "project-directory",
          projectRoot: "/repo/mold",
        },
        {
          name: "other:gallery",
          source: "project-directory",
          projectRoot: "/repo/other",
        },
      ],
      [],
      [],
      "/repo/mold",
    );

    expect(items.map((item) => item.label)).toEqual(["mold:gallery"]);
  });

  it("hides disabled project-directory rows when their project is not active", () => {
    const items = buildExtensionSidebarItems(
      [],
      [],
      [
        {
          name: "mold:image-gallery",
          source: "project-directory",
          projectRoot: "/repo/mold",
        },
        { name: "@mold/repo-gallery", source: "extension-package" },
        { name: "global-user-ext", source: "directory" },
      ],
      "/repo/claudette",
    );

    // Project-directory disabled row for mold is hidden under claudette;
    // extension-package and user-directory entries stay visible.
    expect(items.map((item) => item.id)).toEqual([
      "ext-disabled:@mold/repo-gallery",
      "ext-disabled:global-user-ext",
    ]);
  });

  it("shows disabled project-directory rows when their project IS active", () => {
    const items = buildExtensionSidebarItems(
      [],
      [],
      [
        {
          name: "mold:image-gallery",
          source: "project-directory",
          projectRoot: "/repo/mold",
        },
      ],
      "/repo/mold",
    );

    expect(items.map((item) => item.id)).toEqual([
      "ext-disabled:mold:image-gallery",
    ]);
  });

  it("treats legacy string-only disabled entries as global", () => {
    const items = buildExtensionSidebarItems(
      [],
      [],
      ["legacy-no-source"],
      "/repo/anything",
    );

    expect(items.map((item) => item.id)).toEqual([
      "ext-disabled:legacy-no-source",
    ]);
  });
});
