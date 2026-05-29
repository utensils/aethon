import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _clearProjectIconCache,
  discoverIcon,
  iconForProject,
} from "./projectIcons";
import type { Project } from "./projects";

interface InvokeArgs {
  root?: string;
  path?: string;
  projectPath?: string;
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

async function setInvoke(
  impl: (cmd: string, args: InvokeArgs) => unknown,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  (
    invoke as unknown as { mockImplementation: (i: typeof impl) => void }
  ).mockImplementation(impl);
}

function project(extra: Partial<Project> = {}): Project {
  return {
    id: "p1",
    label: "p1",
    path: "/repos/p1",
    lastUsed: 1,
    ...extra,
  };
}

afterEach(() => {
  _clearProjectIconCache();
  vi.resetAllMocks();
});

describe("iconForProject", () => {
  it("returns cached iconUrl synchronously", () => {
    expect(
      iconForProject(project({ iconUrl: "data:image/png;base64,xxx" })),
    ).toBe("data:image/png;base64,xxx");
    expect(iconForProject(project())).toBeNull();
  });
});

describe("discoverIcon", () => {
  it("returns the persisted iconUrl on cached projects without scanning", async () => {
    const persisted = project({ iconUrl: "data:image/png;base64,cached" });
    await setInvoke(() => {
      throw new Error("should not be called");
    });
    expect(await discoverIcon(persisted)).toBe("data:image/png;base64,cached");
  });

  it("returns the data URL from fs_discover_project_icon", async () => {
    await setInvoke((cmd, args) => {
      if (
        cmd === "fs_discover_project_icon" &&
        args?.projectPath === "/repos/p1"
      ) {
        return "data:image/png;base64,ABCD";
      }
      return null;
    });
    const result = await discoverIcon(project());
    expect(result).toBe("data:image/png;base64,ABCD");
  });

  it("upgrades a persisted remote avatar to a freshly-found local icon", async () => {
    const withAvatar = project({
      iconUrl: "https://github.com/utensils.png?size=200",
    });
    await setInvoke((cmd) => {
      if (cmd === "fs_discover_project_icon")
        return "data:image/svg+xml;base64,LOGO";
      return null;
    });
    expect(await discoverIcon(withAvatar)).toBe(
      "data:image/svg+xml;base64,LOGO",
    );
  });

  it("keeps the persisted remote avatar when no local icon is found", async () => {
    const withAvatar = project({
      iconUrl: "https://github.com/utensils.png?size=200",
    });
    await setInvoke((cmd) => {
      if (cmd === "fs_discover_project_icon") return null;
      // gh should not be consulted — we already have a remote url to keep.
      if (cmd === "gh_repo_avatar_url") throw new Error("should not be called");
      return null;
    });
    expect(await discoverIcon(withAvatar)).toBe(
      "https://github.com/utensils.png?size=200",
    );
  });

  it("falls back to gh_repo_avatar_url when no local icon exists", async () => {
    await setInvoke((cmd) => {
      if (cmd === "fs_discover_project_icon") return null;
      if (cmd === "gh_repo_avatar_url") {
        return "https://github.com/utensils.png?size=200";
      }
      return null;
    });
    const result = await discoverIcon(project());
    expect(result).toBe("https://github.com/utensils.png?size=200");
  });

  it("returns null when scan + gh both miss, and caches the negative result", async () => {
    let calls = 0;
    await setInvoke((cmd) => {
      calls += 1;
      if (cmd === "fs_discover_project_icon") return null;
      if (cmd === "gh_repo_avatar_url") return null;
      return null;
    });
    const result = await discoverIcon(project());
    expect(result).toBeNull();
    const previousCalls = calls;
    await discoverIcon(project());
    expect(calls).toBe(previousCalls);
  });
});
