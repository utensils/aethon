// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { FileTreePanel } from "./file-tree";
import { visibleChangedDirs } from "./file-tree-watch";

// Mock persist + tauri invoke per-test so the component sees a known
// "empty" persisted-store + a controllable directory listing.
vi.mock("../../../persist", () => ({
  readState: vi.fn(() => Promise.resolve("")),
  writeState: vi.fn(() => Promise.resolve(true)),
}));

import { readState, writeState } from "../../../persist";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const listenMock = listen as unknown as ReturnType<typeof vi.fn>;
const readStateMock = readState as ReturnType<typeof vi.fn>;
const writeStateMock = writeState as ReturnType<typeof vi.fn>;

function panelProps(overrides?: Partial<Parameters<typeof FileTreePanel>[0]>) {
  return {
    component: { id: "file-tree", type: "file-tree", props: {} },
    state: { project: { path: "/projects/aethon", name: "aethon" } },
    onEvent: vi.fn(),
    renderChildWithState: () => null,
    ...overrides,
  } as unknown as Parameters<typeof FileTreePanel>[0];
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockResolvedValue(() => {});
  readStateMock.mockReset();
  readStateMock.mockResolvedValue("");
  writeStateMock.mockReset();
  writeStateMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  // Portal-mounted context menus survive React Testing Library's default
  // autocleanup until the component unmounts; call cleanup explicitly so
  // each test starts with an empty document.body.
  cleanup();
  invokeMock.mockReset();
  listenMock.mockReset();
  vi.useRealTimers();
});

describe("FileTreePanel", () => {
  it("falls back to the Aethon home dir when no project is active", async () => {
    invokeMock
      .mockResolvedValueOnce("/Users/test/.aethon")
      .mockResolvedValueOnce([
        {
          name: "system-prompt.md",
          path: "/Users/test/.aethon/system-prompt.md",
          kind: "file",
        },
      ]);
    render(<FileTreePanel {...panelProps({ state: {} })} />);
    await waitFor(() => screen.getByText("system-prompt.md"));
    expect(screen.getByText(".aethon")).toBeTruthy();
    expect(invokeMock).toHaveBeenNthCalledWith(1, "aethon_home_dir");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "fs_list_dir", {
      root: "/Users/test/.aethon",
      path: "/Users/test/.aethon",
    });
  });

  it("lists the project root on mount", async () => {
    invokeMock.mockResolvedValueOnce([
      { name: "src", path: "/projects/aethon/src", kind: "dir" },
      {
        name: "package.json",
        path: "/projects/aethon/package.json",
        kind: "file",
      },
    ]);
    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText("src"));
    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.getByText("package.json")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("fs_list_dir", {
      root: "/projects/aethon",
      path: "/projects/aethon",
    });
  });

  it("renders Git status decorations for changed files and folders", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
          {
            name: "README.md",
            path: "/projects/aethon/README.md",
            kind: "file",
          },
          {
            name: "package.json",
            path: "/projects/aethon/package.json",
            kind: "file",
          },
        ]);
      }
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon/src") {
        return Promise.resolve([
          {
            name: "App.tsx",
            path: "/projects/aethon/src/App.tsx",
            kind: "file",
          },
          {
            name: "new.ts",
            path: "/projects/aethon/src/new.ts",
            kind: "file",
          },
        ]);
      }
      if (cmd === "git_file_status") {
        return Promise.resolve([
          { path: "README.md", status: "modified" },
          { path: "src/new.ts", status: "untracked" },
        ]);
      }
      return Promise.resolve(1);
    });

    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByLabelText("Modified"));
    expect(screen.getByText("README.md").closest("li")?.className).toContain(
      "git-status-modified",
    );
    expect(screen.getByText("src").closest("li")?.className).toContain(
      "git-status-descendant",
    );

    fireEvent.click(screen.getByText("src"));
    await waitFor(() => screen.getByLabelText("Untracked"));
    expect(screen.getByText("new.ts").closest("li")?.className).toContain(
      "git-status-untracked",
    );
    expect(screen.queryByLabelText("Added")).toBeNull();
  });

  it("renders deleted Git entries that are missing from fs_list_dir", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
        ]);
      }
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon/src") {
        return Promise.resolve([]);
      }
      if (cmd === "git_file_status") {
        return Promise.resolve([{ path: "src/old.ts", status: "deleted" }]);
      }
      return Promise.resolve(1);
    });

    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText("src"));
    fireEvent.click(screen.getByText("src"));
    await waitFor(() => screen.getByText("old.ts"));
    expect(screen.getByLabelText("Deleted")).toBeTruthy();
  });

  it("uses the project path separator for synthetic deleted rows", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "C:\\repo") {
        return Promise.resolve([
          { name: "src", path: "C:\\repo\\src", kind: "dir" },
        ]);
      }
      if (cmd === "fs_list_dir" && args?.path === "C:\\repo\\src") {
        return Promise.resolve([]);
      }
      if (cmd === "git_file_status") {
        return Promise.resolve([{ path: "src/old.ts", status: "deleted" }]);
      }
      return Promise.resolve(1);
    });

    render(
      <FileTreePanel
        {...panelProps({
          state: { project: { path: "C:\\repo", name: "repo" } },
        })}
      />,
    );
    await waitFor(() => screen.getByText("src"));
    fireEvent.click(screen.getByText("src"));
    const deleted = await waitFor(() => screen.getByText("old.ts"));
    expect(deleted.closest("li")?.getAttribute("title")).toContain(
      "C:\\repo\\src\\old.ts",
    );
  });

  it("renders clean Git file trees without decorations", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "fs_list_dir") {
        return Promise.resolve([
          {
            name: "README.md",
            path: "/projects/aethon/README.md",
            kind: "file",
          },
        ]);
      }
      if (cmd === "git_file_status") return Promise.resolve([]);
      return Promise.resolve(1);
    });

    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText("README.md"));
    expect(screen.queryByLabelText("Modified")).toBeNull();
    expect(screen.queryByLabelText("Untracked")).toBeNull();
  });

  it("renders non-git file trees without decorations", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "fs_list_dir") {
        return Promise.resolve([
          {
            name: "README.md",
            path: "/projects/aethon/README.md",
            kind: "file",
          },
        ]);
      }
      if (cmd === "git_file_status") return Promise.resolve(null);
      return Promise.resolve(1);
    });

    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText("README.md"));
    expect(screen.queryByLabelText("Modified")).toBeNull();
    expect(screen.queryByLabelText("Untracked")).toBeNull();
  });

  it("greys out ignored paths and gives them no git decoration", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon") {
        return Promise.resolve([
          {
            name: "node_modules",
            path: "/projects/aethon/node_modules",
            kind: "dir",
          },
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
        ]);
      }
      if (cmd === "git_file_status") return Promise.resolve([]);
      if (cmd === "git_ignored_paths")
        return Promise.resolve(["node_modules/"]);
      return Promise.resolve(1);
    });

    render(<FileTreePanel {...panelProps()} />);
    const ignoredLi = await waitFor(() => {
      const li = screen.getByText("node_modules").closest("li");
      if (!li?.className.includes("is-ignored")) throw new Error("not yet");
      return li;
    });
    expect(ignoredLi.className).not.toContain("has-git-status");
    // a non-ignored sibling stays undimmed
    expect(screen.getByText("src").closest("li")?.className).not.toContain(
      "is-ignored",
    );
  });

  it("shows the propagated status letter (not a bullet) on a changed dir", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
        ]);
      }
      if (cmd === "git_file_status")
        return Promise.resolve([{ path: "src/app.ts", status: "modified" }]);
      if (cmd === "git_ignored_paths") return Promise.resolve([]);
      return Promise.resolve(1);
    });

    render(<FileTreePanel {...panelProps()} />);
    const srcLi = await waitFor(() => {
      const li = screen.getByText("src").closest("li");
      if (!li?.className.includes("git-status-descendant")) {
        throw new Error("not yet");
      }
      return li;
    });
    const badge = srcLi.querySelector(".ae-file-tree-git-decoration");
    expect(badge?.textContent).toBe("M");
  });

  it("renders header actions, svg twisties, and depth indent guides", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
        ]);
      }
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon/src") {
        return Promise.resolve([
          { name: "app.ts", path: "/projects/aethon/src/app.ts", kind: "file" },
        ]);
      }
      if (cmd === "git_file_status") return Promise.resolve([]);
      return Promise.resolve(1);
    });

    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText("src"));
    for (const label of ["New File", "New Folder", "Refresh files"]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    // Expand/Collapse-all live in the header right-click menu, not the toolbar.
    expect(screen.queryByLabelText("Expand All")).toBeNull();
    const srcRow = screen.getByText("src").closest("li");
    expect(srcRow?.querySelector(".ae-file-tree-chevron-row svg")).toBeTruthy();
    expect(srcRow?.querySelectorAll(".ae-file-tree-guide").length).toBe(0);

    fireEvent.click(screen.getByText("src"));
    await waitFor(() => screen.getByText("app.ts"));
    const childRow = screen.getByText("app.ts").closest("li");
    expect(childRow?.querySelectorAll(".ae-file-tree-guide").length).toBe(1);
  });

  it("offers Expand/Collapse All in the header right-click menu", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "fs_list_dir") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
        ]);
      }
      if (cmd === "git_file_status") return Promise.resolve([]);
      return Promise.resolve(1);
    });

    const { container } = render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText("src"));
    const titlebar = container.querySelector(".ae-file-tree-titlebar");
    fireEvent.contextMenu(titlebar as Element);
    expect(screen.getByRole("menuitem", { name: /Expand All/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Collapse All/ })).toBeTruthy();
  });

  it("highlights the row for the file open in the focused editor tab", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "fs_list_dir") {
        return Promise.resolve([
          {
            name: "README.md",
            path: "/projects/aethon/README.md",
            kind: "file",
          },
        ]);
      }
      if (cmd === "git_file_status") return Promise.resolve([]);
      return Promise.resolve(1);
    });

    render(
      <FileTreePanel
        {...panelProps({
          state: {
            project: { path: "/projects/aethon", name: "aethon" },
            tabs: [
              {
                id: "t1",
                kind: "editor",
                editor: {
                  rootPath: "/projects/aethon",
                  filePath: "/projects/aethon/README.md",
                },
              },
            ],
            activeTabId: "t1",
          },
        })}
      />,
    );
    await waitFor(() => screen.getByText("README.md"));
    expect(screen.getByText("README.md").closest("li")?.className).toContain(
      "is-active",
    );
  });

  it("expand all reveals nested folders but skips ignored dirs", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
          {
            name: "node_modules",
            path: "/projects/aethon/node_modules",
            kind: "dir",
          },
        ]);
      }
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon/src") {
        return Promise.resolve([
          { name: "app.ts", path: "/projects/aethon/src/app.ts", kind: "file" },
        ]);
      }
      if (
        cmd === "fs_list_dir" &&
        args?.path === "/projects/aethon/node_modules"
      ) {
        return Promise.resolve([
          {
            name: "pkg",
            path: "/projects/aethon/node_modules/pkg",
            kind: "dir",
          },
        ]);
      }
      if (cmd === "git_file_status") return Promise.resolve([]);
      if (cmd === "git_ignored_paths")
        return Promise.resolve(["node_modules/"]);
      return Promise.resolve(1);
    });

    const { container } = render(<FileTreePanel {...panelProps()} />);
    // Wait until the ignored set has loaded so expand-all can honor it.
    await waitFor(() => {
      const li = screen.getByText("node_modules").closest("li");
      if (!li?.className.includes("is-ignored")) throw new Error("not yet");
    });
    fireEvent.contextMenu(
      container.querySelector(".ae-file-tree-titlebar") as Element,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Expand All/ }));
    await waitFor(() => screen.getByText("app.ts"));
    // The ignored dir was never descended into.
    expect(screen.queryByText("pkg")).toBeNull();
  });

  it("collapse all (header menu) hides expanded folders", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
        ]);
      }
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon/src") {
        return Promise.resolve([
          { name: "app.ts", path: "/projects/aethon/src/app.ts", kind: "file" },
        ]);
      }
      if (cmd === "git_file_status") return Promise.resolve([]);
      return Promise.resolve(1);
    });

    const { container } = render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText("src"));
    fireEvent.click(screen.getByText("src"));
    await waitFor(() => screen.getByText("app.ts"));
    fireEvent.contextMenu(
      container.querySelector(".ae-file-tree-titlebar") as Element,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Collapse All/ }));
    await waitFor(() => expect(screen.queryByText("app.ts")).toBeNull());
  });

  it("expands a single directory's subtree from its right-click menu", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
        ]);
      }
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon/src") {
        return Promise.resolve([
          { name: "ui", path: "/projects/aethon/src/ui", kind: "dir" },
        ]);
      }
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon/src/ui") {
        return Promise.resolve([
          {
            name: "Button.tsx",
            path: "/projects/aethon/src/ui/Button.tsx",
            kind: "file",
          },
        ]);
      }
      if (cmd === "git_file_status") return Promise.resolve([]);
      if (cmd === "git_ignored_paths") return Promise.resolve([]);
      return Promise.resolve(1);
    });

    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText("src"));
    fireEvent.contextMenu(screen.getByText("src").closest("li") as Element);
    fireEvent.click(screen.getByRole("menuitem", { name: /Expand All/ }));
    // The whole src subtree opens — the nested file becomes visible.
    await waitFor(() => screen.getByText("Button.tsx"));
  });

  it("watches the visible project directories without recursive scans", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "fs_list_dir") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
        ]);
      }
      return Promise.resolve(1);
    });
    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText("src"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("fs_watch_dirs", {
        root: "/projects/aethon",
        dirs: ["/projects/aethon"],
      });
    });
  });

  it("filters fs-tree-changed payloads to visible folders", () => {
    expect(
      visibleChangedDirs(
        {
          root: "/projects/aethon",
          dirs: ["/projects/aethon", "/projects/aethon/node_modules"],
        },
        "/projects/aethon",
        ["/projects/aethon", "/projects/aethon/src"],
      ),
    ).toEqual(["/projects/aethon"]);
    expect(
      visibleChangedDirs(
        { root: "/projects/other", dirs: ["/projects/other"] },
        "/projects/aethon",
        ["/projects/aethon"],
      ),
    ).toEqual([]);
  });

  it("fires file-tree-open when a file row is clicked", async () => {
    invokeMock.mockResolvedValueOnce([
      { name: "App.tsx", path: "/projects/aethon/src/App.tsx", kind: "file" },
    ]);
    const onEvent = vi.fn();
    render(<FileTreePanel {...panelProps({ onEvent })} />);
    const row = await waitFor(() => screen.getByText("App.tsx"));
    row.click();
    expect(onEvent).toHaveBeenCalledWith("file-tree-open", {
      filePath: "/projects/aethon/src/App.tsx",
      rootPath: "/projects/aethon",
    });
  });

  it("uses the active editor root when no project is active", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        name: "system-prompt.md",
        path: "/Users/test/.aethon/system-prompt.md",
        kind: "file",
      },
    ]);
    render(
      <FileTreePanel
        {...panelProps({
          state: {
            activeTabId: "editor-1",
            tabs: [
              {
                id: "editor-1",
                kind: "editor",
                editor: { rootPath: "/Users/test/.aethon" },
              },
            ],
          },
        })}
      />,
    );
    await waitFor(() => screen.getByText("system-prompt.md"));
    expect(invokeMock).toHaveBeenCalledWith("fs_list_dir", {
      root: "/Users/test/.aethon",
      path: "/Users/test/.aethon",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("aethon_home_dir");
  });

  it("renders an error state when fs_list_dir rejects", async () => {
    invokeMock.mockRejectedValueOnce("permission denied");
    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText(/permission denied/));
    expect(screen.getByText(/permission denied/)).toBeTruthy();
  });

  it("opens a context menu on right-click and exposes the action set", async () => {
    invokeMock.mockResolvedValueOnce([
      { name: "App.tsx", path: "/projects/aethon/src/App.tsx", kind: "file" },
    ]);
    render(<FileTreePanel {...panelProps()} />);
    const row = await waitFor(() => screen.getByText("App.tsx"));
    fireEvent.contextMenu(row);
    expect(screen.getByRole("menuitem", { name: /New File…/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /New Folder…/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Rename…/ })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Move to Trash…/ }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Copy Path/ })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Copy Relative Path/ }),
    ).toBeTruthy();
  });

  it("renames files inline from the context menu", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon") {
        return Promise.resolve([
          {
            name: "README.md",
            path: "/projects/aethon/README.md",
            kind: "file",
          },
        ]);
      }
      if (cmd === "git_file_status" || cmd === "git_ignored_paths") {
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    });
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("ignored");
    const onEvent = vi.fn();
    render(<FileTreePanel {...panelProps({ onEvent })} />);

    const row = await waitFor(() => screen.getByText("README.md"));
    const rootListCallCount = () =>
      invokeMock.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "fs_list_dir" &&
          (args as { path?: string } | undefined)?.path === "/projects/aethon",
      ).length;
    const listCallsBeforeRename = rootListCallCount();
    fireEvent.contextMenu(row.closest("li") as Element);
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename…/ }));

    expect(promptSpy).not.toHaveBeenCalled();
    const input = await screen.findByRole<HTMLInputElement>("textbox", {
      name: /Rename README\.md/,
    });
    expect(input.value).toBe("README.md");
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "CHANGELOG.md" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("fs_rename", {
        root: "/projects/aethon",
        from: "/projects/aethon/README.md",
        to: "/projects/aethon/CHANGELOG.md",
      });
    });
    expect(onEvent).toHaveBeenCalledWith("file-tree-rename", {
      from: "/projects/aethon/README.md",
      to: "/projects/aethon/CHANGELOG.md",
      kind: "file",
    });
    await waitFor(() => {
      expect(rootListCallCount()).toBeGreaterThan(listCallsBeforeRename);
    });
  });

  it("closes an open context menu when the project changes", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon") {
        return Promise.resolve([
          {
            name: "App.tsx",
            path: "/projects/aethon/src/App.tsx",
            kind: "file",
          },
        ]);
      }
      if (cmd === "fs_list_dir" && args?.path === "/projects/other") {
        return Promise.resolve([
          {
            name: "README.md",
            path: "/projects/other/README.md",
            kind: "file",
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const { rerender } = render(<FileTreePanel {...panelProps()} />);
    const row = await waitFor(() => screen.getByText("App.tsx"));
    fireEvent.contextMenu(row);
    expect(screen.getByRole("menuitem", { name: /New File…/ })).toBeTruthy();

    rerender(
      <FileTreePanel
        {...panelProps({
          state: { project: { path: "/projects/other", name: "other" } },
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: /New File…/ })).toBeNull();
    });
  });

  it("creates a file via the New File menu and opens it", async () => {
    invokeMock.mockResolvedValueOnce([
      { name: "src", path: "/projects/aethon/src", kind: "dir" },
    ]);
    const onEvent = vi.fn();
    render(<FileTreePanel {...panelProps({ onEvent })} />);
    const row = await waitFor(() => screen.getByText("src"));
    fireEvent.contextMenu(row);
    // fs_create_file then fs_list_dir refresh.
    invokeMock.mockResolvedValueOnce(undefined);
    invokeMock.mockResolvedValueOnce([
      { name: "new.ts", path: "/projects/aethon/src/new.ts", kind: "file" },
    ]);
    vi.spyOn(window, "prompt").mockReturnValueOnce("new.ts");
    const newFileBtn = screen.getByRole("menuitem", { name: /New File…/ });
    fireEvent.click(newFileBtn);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("fs_create_file", {
        root: "/projects/aethon",
        path: "/projects/aethon/src/new.ts",
      });
    });
    await waitFor(() => {
      expect(onEvent).toHaveBeenCalledWith("file-tree-open", {
        filePath: "/projects/aethon/src/new.ts",
        rootPath: "/projects/aethon",
      });
    });
  });

  it("persists expanded folders under the project active when scheduled", async () => {
    invokeMock.mockResolvedValue([
      { name: "src", path: "/projects/aethon/src", kind: "dir" },
    ]);
    const { rerender } = render(<FileTreePanel {...panelProps()} />);
    const row = await waitFor(() => screen.getByText("src"));
    vi.useFakeTimers();
    fireEvent.click(row);
    rerender(
      <FileTreePanel
        {...panelProps({
          state: { project: { path: "/projects/other", name: "other" } },
        })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(writeStateMock).toHaveBeenCalledWith(
      "file-tree.json",
      JSON.stringify({
        byProject: {
          "/projects/aethon": ["/projects/aethon/src"],
        },
      }),
    );
  });

  it("keeps expanded descendants visible when the root listing refreshes", async () => {
    let fsTreeChangedListener:
      | ((event: { payload: { root: string; dirs: string[] } }) => void)
      | undefined;
    listenMock.mockImplementation((eventName: string, listener) => {
      if (eventName === "fs-tree-changed") {
        fsTreeChangedListener = listener as typeof fsTreeChangedListener;
      }
      return Promise.resolve(() => {});
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd !== "fs_list_dir") return Promise.resolve(1);
      if (args?.path === "/projects/aethon/src") {
        return Promise.resolve([
          {
            name: "App.tsx",
            path: "/projects/aethon/src/App.tsx",
            kind: "file",
          },
        ]);
      }
      return Promise.resolve([
        { name: "src", path: "/projects/aethon/src", kind: "dir" },
        {
          name: "package.json",
          path: "/projects/aethon/package.json",
          kind: "file",
        },
      ]);
    });

    render(<FileTreePanel {...panelProps()} />);
    const srcRow = await waitFor(() => screen.getByText("src"));
    fireEvent.click(srcRow);
    await waitFor(() => screen.getByText("App.tsx"));

    act(() => {
      fsTreeChangedListener?.({
        payload: { root: "/projects/aethon", dirs: ["/projects/aethon"] },
      });
    });

    await waitFor(() => {
      expect(screen.getByText("App.tsx")).toBeTruthy();
      expect(
        screen.getByText("src").closest("li")?.getAttribute("aria-expanded"),
      ).toBe("true");
    });
  });

  it("refreshes expanded folders when an agent turn ends after creating a nested file", async () => {
    let agentFileCreated = false;
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
        ]);
      }
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon/src") {
        return Promise.resolve([
          {
            name: "old.ts",
            path: "/projects/aethon/src/old.ts",
            kind: "file",
          },
          ...(agentFileCreated
            ? [
                {
                  name: "agent-created.ts",
                  path: "/projects/aethon/src/agent-created.ts",
                  kind: "file",
                },
              ]
            : []),
        ]);
      }
      if (cmd === "git_file_status" || cmd === "git_ignored_paths") {
        return Promise.resolve([]);
      }
      return Promise.resolve(1);
    });

    const { rerender } = render(
      <FileTreePanel
        {...panelProps({
          state: {
            project: { path: "/projects/aethon", name: "aethon" },
            waiting: true,
          },
        })}
      />,
    );
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("old.ts");

    agentFileCreated = true;
    rerender(
      <FileTreePanel
        {...panelProps({
          state: {
            project: { path: "/projects/aethon", name: "aethon" },
            waiting: false,
          },
        })}
      />,
    );

    await screen.findByText("agent-created.ts");
  });

  it("manual refresh reloads expanded folders, not just the root listing", async () => {
    let agentFileCreated = false;
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
        ]);
      }
      if (cmd === "fs_list_dir" && args?.path === "/projects/aethon/src") {
        return Promise.resolve([
          {
            name: "old.ts",
            path: "/projects/aethon/src/old.ts",
            kind: "file",
          },
          ...(agentFileCreated
            ? [
                {
                  name: "agent-created.ts",
                  path: "/projects/aethon/src/agent-created.ts",
                  kind: "file",
                },
              ]
            : []),
        ]);
      }
      if (cmd === "git_file_status" || cmd === "git_ignored_paths") {
        return Promise.resolve([]);
      }
      return Promise.resolve(1);
    });

    render(<FileTreePanel {...panelProps()} />);
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("old.ts");

    agentFileCreated = true;
    fireEvent.click(screen.getByLabelText("Refresh files"));

    await screen.findByText("agent-created.ts");
  });

  it("refreshes git decorations when a git-state-changed event fires for the root", async () => {
    let gitStateListener:
      | ((event: { payload: { root: string } }) => void)
      | undefined;
    listenMock.mockImplementation((eventName: string, listener) => {
      if (eventName === "git-state-changed") {
        gitStateListener = listener as typeof gitStateListener;
      }
      return Promise.resolve(() => {});
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "fs_list_dir") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
        ]);
      }
      if (cmd === "git_file_status") return Promise.resolve([]);
      if (cmd === "git_ignored_paths") return Promise.resolve([]);
      return Promise.resolve(1);
    });

    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText("src"));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some((c) => c[0] === "git_file_status"),
      ).toBe(true),
    );
    const before = invokeMock.mock.calls.filter(
      (c) => c[0] === "git_file_status",
    ).length;

    // External `git commit`: only `.git/` changed, so no fs-tree-changed —
    // the git watcher's git-state-changed must drive the decoration refresh.
    act(() => {
      gitStateListener?.({ payload: { root: "/projects/aethon" } });
    });

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter((c) => c[0] === "git_file_status").length,
      ).toBeGreaterThan(before),
    );
  });

  it("ignores git-state-changed events for a different root", async () => {
    let gitStateListener:
      | ((event: { payload: { root: string } }) => void)
      | undefined;
    listenMock.mockImplementation((eventName: string, listener) => {
      if (eventName === "git-state-changed") {
        gitStateListener = listener as typeof gitStateListener;
      }
      return Promise.resolve(() => {});
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "fs_list_dir") {
        return Promise.resolve([
          { name: "src", path: "/projects/aethon/src", kind: "dir" },
        ]);
      }
      if (cmd === "git_file_status") return Promise.resolve([]);
      if (cmd === "git_ignored_paths") return Promise.resolve([]);
      return Promise.resolve(1);
    });

    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText("src"));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some((c) => c[0] === "git_file_status"),
      ).toBe(true),
    );
    const before = invokeMock.mock.calls.filter(
      (c) => c[0] === "git_file_status",
    ).length;

    act(() => {
      gitStateListener?.({ payload: { root: "/projects/other" } });
    });
    await new Promise((r) => setTimeout(r, 220));
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "git_file_status").length,
    ).toBe(before);
  });

  it("reveals a nested file on aethon:reveal-in-tree", async () => {
    // jsdom doesn't define scrollIntoView; install a spy so the reveal
    // effect is safe and observable.
    const scrollSpy = vi.fn();
    const proto = Element.prototype as unknown as {
      scrollIntoView?: () => void;
    };
    const prevScroll = proto.scrollIntoView;
    proto.scrollIntoView = scrollSpy;
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir") {
        if (args?.path === "/projects/aethon") {
          return Promise.resolve([
            { name: "src", path: "/projects/aethon/src", kind: "dir" },
          ]);
        }
        if (args?.path === "/projects/aethon/src") {
          return Promise.resolve([
            {
              name: "App.tsx",
              path: "/projects/aethon/src/App.tsx",
              kind: "file",
            },
          ]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText("src"));
    // The nested file isn't visible until the ancestor expands.
    expect(screen.queryByText("App.tsx")).toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("aethon:reveal-in-tree", {
          detail: { filePath: "/projects/aethon/src/App.tsx" },
        }),
      );
    });

    const appRow = await waitFor(() => screen.getByText("App.tsx"));
    expect(appRow.closest("li")?.className).toContain("is-revealed");
    // scrollIntoView fires in a `revealed`-keyed effect that flushes a tick
    // after the row commits, so poll rather than assert synchronously — the
    // synchronous check raced under CI load and flaked on macOS.
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    proto.scrollIntoView = prevScroll;
  });
});
