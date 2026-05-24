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

  it("treats legacy string-only disabled entries with no `:` as global", () => {
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

  it("hides legacy bare-name project-directory entries when prefix !== active basename", () => {
    // No `source` metadata (pre-v0.3 file) — fall back to the name
    // heuristic: `mold:image-gallery` parses as project-directory rooted
    // at `mold`, which does NOT match the claudette basename.
    const items = buildExtensionSidebarItems(
      [],
      [],
      ["mold:image-gallery", "@mold/repo-gallery-clickable-image"],
      "/repo/claudette",
    );

    // Only the npm-scoped package row survives — the `mold:…` row is
    // hidden because claudette isn't `mold`.
    expect(items.map((item) => item.id)).toEqual([
      "ext-disabled:@mold/repo-gallery-clickable-image",
    ]);
  });

  it("shows legacy bare-name project-directory entries when the basename matches", () => {
    const items = buildExtensionSidebarItems(
      [],
      [],
      ["mold:image-gallery"],
      "/Users/me/Projects/mold",
    );

    expect(items.map((item) => item.id)).toEqual([
      "ext-disabled:mold:image-gallery",
    ]);
  });

  it("scopes @<project>/<pkg> npm packages to that project's basename", () => {
    const knownProjects = new Set(["mold", "claudette", "nyc-real-estate"]);
    // mold isn't active — `@mold/repo-gallery-clickable-image` should hide
    const hidden = buildExtensionSidebarItems(
      [],
      [],
      [
        {
          name: "@mold/repo-gallery-clickable-image",
          source: "extension-package",
        },
      ],
      "/Users/me/Projects/nyc-real-estate",
      knownProjects,
    );
    expect(hidden).toEqual([]);

    // mold IS active — same package shows
    const shown = buildExtensionSidebarItems(
      [],
      [],
      [
        {
          name: "@mold/repo-gallery-clickable-image",
          source: "extension-package",
        },
      ],
      "/Users/me/Projects/mold",
      knownProjects,
    );
    expect(shown.map((item) => item.id)).toEqual([
      "ext-disabled:@mold/repo-gallery-clickable-image",
    ]);
  });

  it("leaves @scope/<pkg> packages global when scope is not a known project", () => {
    // `@example` isn't a project the user has opened — keep it visible
    // everywhere so the user can still re-enable from anywhere.
    const items = buildExtensionSidebarItems(
      [],
      [],
      [{ name: "@example/global-helper", source: "extension-package" }],
      "/Users/me/Projects/anything",
      new Set(["mold", "claudette"]),
    );
    expect(items.map((item) => item.id)).toEqual([
      "ext-disabled:@example/global-helper",
    ]);
  });

  it("filters LOADED @<project>/<pkg> packages by active project too", () => {
    const knownProjects = new Set(["mold", "nyc-real-estate"]);
    const items = buildExtensionSidebarItems(
      [
        {
          name: "@mold/repo-gallery-clickable-image",
          source: "extension-package",
        },
        { name: "@example/global-helper", source: "extension-package" },
      ],
      [],
      [],
      "/Users/me/Projects/nyc-real-estate",
      knownProjects,
    );
    // mold-scoped package hidden under nyc-real-estate; example stays.
    expect(items.map((item) => item.label)).toEqual(["@example/global-helper"]);
  });
});
