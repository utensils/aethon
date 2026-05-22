// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { FileTreePanel } from "./file-tree";

// Mock persist + tauri invoke per-test so the component sees a known
// "empty" persisted-store + a controllable directory listing.
vi.mock("../../../persist", () => ({
  readState: vi.fn(() => Promise.resolve("")),
  writeState: vi.fn(() => Promise.resolve(true)),
}));

import { readState } from "../../../persist";
import { invoke } from "@tauri-apps/api/core";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const readStateMock = readState as unknown as ReturnType<typeof vi.fn>;

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
  readStateMock.mockReset();
  readStateMock.mockResolvedValue("");
});

afterEach(() => {
  invokeMock.mockReset();
});

describe("FileTreePanel", () => {
  it("shows an empty state when no project is active", () => {
    render(
      <FileTreePanel
        {...panelProps({ state: {} as Record<string, unknown> })}
      />,
    );
    expect(screen.getByText("no project")).toBeTruthy();
  });

  it("lists the project root on mount", async () => {
    invokeMock.mockResolvedValueOnce([
      { name: "src", path: "/projects/aethon/src", kind: "dir" },
      { name: "package.json", path: "/projects/aethon/package.json", kind: "file" },
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
    });
  });

  it("renders an error state when fs_list_dir rejects", async () => {
    invokeMock.mockRejectedValueOnce("permission denied");
    render(<FileTreePanel {...panelProps()} />);
    await waitFor(() => screen.getByText(/permission denied/));
    expect(screen.getByText(/permission denied/)).toBeTruthy();
  });
});
