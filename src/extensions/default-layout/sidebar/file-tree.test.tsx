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
});
