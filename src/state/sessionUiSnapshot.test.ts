// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { makeEmptyTab } from "../types/tab";
import {
  loadSessionUiSnapshot,
  parseSessionUiSnapshot,
  saveSessionUiSnapshot,
} from "./sessionUiSnapshot";

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage?.clear?.();
});

describe("sessionUiSnapshot", () => {
  it("round-trips open tabs, active tab, and chrome state", () => {
    const tabA = {
      ...makeEmptyTab("tab-a", "A"),
      cwd: "/repo/a-worktree",
      messages: [{ id: "m1", role: "user" as const, text: "hi" }],
    };
    const tabB = {
      ...makeEmptyTab("tab-b", "B"),
      canvas: { type: "card", children: [] },
    };

    saveSessionUiSnapshot({
      tabs: [tabA, tabB],
      activeTabId: "tab-b",
      layout: {
        sidebarVisible: true,
        columns: "300px minmax(0,1fr)",
      },
      terminal: { open: true },
      terminalPanel: { activeSubId: "agent-bash", height: 240 },
      projectModels: { "project-1": "anthropic/claude-opus-4-7" },
      // A backgrounded workspace's tabs ride along in persistedTabBuckets so
      // a restart can restore them when the user switches to that workspace.
      persistedTabBuckets: {
        "project-2": {
          tabs: [
            {
              ...makeEmptyTab("bt-1", "Bucket Tab", "project-2"),
              messages: [{ id: "bm", role: "user" as const, text: "bg" }],
            },
          ],
          activeTabId: "bt-1",
        },
      },
    });

    expect(loadSessionUiSnapshot()).toMatchObject({
      activeTabId: "tab-b",
      tabs: [
        {
          id: "tab-a",
          label: "A",
          cwd: "/repo/a-worktree",
          messages: [{ text: "hi" }],
        },
        { id: "tab-b", label: "B", canvas: { type: "card" } },
      ],
      // Legacy 2-column snapshot upgrades to the new 3-column shape on
      // restore so older sessions still see the right files-sidebar.
      layout: { sidebarVisible: true, columns: "300px minmax(0,1fr) 360px" },
      terminal: { open: true },
      terminalPanel: { activeSubId: "agent-bash", height: 240 },
      projectModels: { "project-1": "anthropic/claude-opus-4-7" },
      buckets: {
        "project-2": {
          tabs: [{ id: "bt-1", label: "Bucket Tab", projectId: "project-2" }],
          activeTabId: "bt-1",
        },
      },
    });
  });

  it("persists buckets-only when the active workspace has no sessions", () => {
    // User sitting on a project overview while agents run in its worktrees:
    // state.tabs is empty but a backgrounded bucket has a session.
    saveSessionUiSnapshot({
      tabs: [],
      activeTabId: "__overview__",
      persistedTabBuckets: {
        "project-1::worktree::wt-1": {
          tabs: [
            {
              ...makeEmptyTab("wt-tab", "WT Tab", "project-1"),
              messages: [{ id: "m", role: "user" as const, text: "hi" }],
            },
          ],
          activeTabId: "wt-tab",
        },
      },
    });

    const loaded = loadSessionUiSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded?.activeTabId).toBe("__overview__");
    expect(loaded?.tabs).toEqual([]);
    expect(loaded?.buckets?.["project-1::worktree::wt-1"]?.activeTabId).toBe(
      "wt-tab",
    );
  });

  it("persists empty agent tabs in the active workspace and background buckets", () => {
    saveSessionUiSnapshot({
      tabs: [makeEmptyTab("empty-active", "Empty Active", "project-1")],
      activeTabId: "empty-active",
      persistedTabBuckets: {
        "project-1::worktree::wt-1": {
          tabs: [makeEmptyTab("empty-bucket", "Empty Bucket", "project-1")],
          activeTabId: "empty-bucket",
        },
      },
    });

    const loaded = loadSessionUiSnapshot();
    expect(loaded?.activeTabId).toBe("empty-active");
    expect(loaded?.tabs).toMatchObject([
      { id: "empty-active", label: "Empty Active", messages: [] },
    ]);
    expect(loaded?.buckets?.["project-1::worktree::wt-1"]?.tabs).toMatchObject([
      { id: "empty-bucket", label: "Empty Bucket", messages: [] },
    ]);
  });

  it("repairs timestamped message order and drops stale stop notices on restore", () => {
    const parsed = parseSessionUiSnapshot(
      JSON.stringify({
        tabs: [
          {
            ...makeEmptyTab("tab", "Tab"),
            messages: [
              {
                id: "later-agent",
                role: "agent",
                text: "later",
                createdAt: 3_000,
              },
              {
                id: "stderr",
                role: "system",
                text: "[agent stderr] 2026-06-02T13:36:55.343Z WARN devshell: failed",
                createdAt: 2_000,
              },
              {
                id: "stopped",
                role: "system",
                text: "Agent stopped.",
                createdAt: 2_500,
              },
              {
                id: "earlier-user",
                role: "user",
                text: "earlier",
                createdAt: 1_000,
              },
            ],
          },
        ],
        activeTabId: "tab",
        savedAt: 1,
      }),
    );

    expect(parsed?.tabs[0].messages.map((message) => message.id)).toEqual([
      "earlier-user",
      "stderr",
      "later-agent",
    ]);
  });

  it("restores agent-owned terminal panel to agent bash instead of a shell sub-tab", () => {
    const parsed = parseSessionUiSnapshot(
      JSON.stringify({
        tabs: [
          {
            ...makeEmptyTab("agent", "Agent"),
            messages: [{ id: "m", role: "user", text: "hi" }],
          },
          {
            ...makeEmptyTab("shell", "Shell", null, "shell"),
            shell: {
              cwd: "/repo/app",
              command: "",
              args: [],
              shareMode: "private",
              shellState: "running",
            },
          },
        ],
        activeTabId: "agent",
        terminalPanel: { activeSubId: "shell", height: 300 },
        savedAt: 1,
      }),
      { restartShellTabs: true },
    );

    expect(parsed?.terminalPanel).toEqual({
      activeSubId: "agent-bash",
      height: 300,
    });
  });

  it("returns null when neither active tabs nor buckets have sessions", () => {
    saveSessionUiSnapshot({ tabs: [], activeTabId: "__overview__" });
    expect(loadSessionUiSnapshot()).toBeNull();
  });

  it("persists closed session ids even when no tabs are open", () => {
    saveSessionUiSnapshot({
      tabs: [],
      activeTabId: "__overview__",
      closedSessionIds: ["closed-a", "closed-b", "closed-a"],
    });

    const loaded = loadSessionUiSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded?.tabs).toEqual([]);
    expect(loaded?.activeTabId).toBe("__overview__");
    expect(loaded?.closedSessionIds).toEqual(["closed-a", "closed-b"]);
  });

  it("falls back to the first tab when the active id is stale", () => {
    const tab = {
      ...makeEmptyTab("tab-a", "A"),
      messages: [{ id: "m1", role: "user" as const, text: "hi" }],
    };
    saveSessionUiSnapshot({
      tabs: [tab],
      activeTabId: "missing",
    });

    expect(loadSessionUiSnapshot()?.activeTabId).toBe("tab-a");
  });

  it("strips transient image preview URLs from persisted snapshots", () => {
    const tab = {
      ...makeEmptyTab("tab-a", "A"),
      messages: [
        {
          id: "m1",
          role: "user" as const,
          attachments: [
            {
              id: "img-1",
              kind: "image" as const,
              path: "/tmp/aethon-pastes/one.png",
              name: "one.png",
              mimeType: "image/png",
              sizeBytes: 12,
              previewUrl: "blob:temp",
            },
          ],
        },
      ],
      draftAttachments: [
        {
          id: "img-2",
          kind: "image" as const,
          path: "/tmp/aethon-pastes/two.png",
          name: "two.png",
          mimeType: "image/png",
          sizeBytes: 13,
          previewUrl: "blob:draft",
        },
      ],
    };

    saveSessionUiSnapshot({
      tabs: [tab],
      activeTabId: "tab-a",
    });

    const restored = loadSessionUiSnapshot();
    expect(restored?.tabs[0].messages[0].attachments?.[0]).toEqual({
      id: "img-1",
      kind: "image",
      path: "/tmp/aethon-pastes/one.png",
      name: "one.png",
      mimeType: "image/png",
      sizeBytes: 12,
    });
    expect(restored?.tabs[0].draftAttachments?.[0]).toEqual({
      id: "img-2",
      kind: "image",
      path: "/tmp/aethon-pastes/two.png",
      name: "two.png",
      mimeType: "image/png",
      sizeBytes: 13,
    });
  });

  it("does not restore persistent localStorage snapshots synchronously", () => {
    const localStorage =
      window.localStorage ??
      (() => {
        const values = new Map<string, string>();
        return {
          get length() {
            return values.size;
          },
          clear: () => values.clear(),
          getItem: (key: string) => values.get(key) ?? null,
          key: (index: number) => [...values.keys()][index] ?? null,
          removeItem: (key: string) => {
            values.delete(key);
          },
          setItem: (key: string, value: string) => {
            values.set(key, value);
          },
        } as Storage;
      })();
    const tab = {
      ...makeEmptyTab("tab-a", "A"),
      messages: [{ id: "m1", role: "user" as const, text: "hi" }],
    };
    localStorage.setItem(
      "aethon:session-ui-snapshot:v1",
      JSON.stringify({
        tabs: [tab],
        activeTabId: "tab-a",
        savedAt: 1,
      }),
    );

    expect(loadSessionUiSnapshot()).toBeNull();
  });

  it("dedupes plain-text copies of rendered tool output on restore", () => {
    const parsed = parseSessionUiSnapshot(
      JSON.stringify({
        tabs: [
          {
            ...makeEmptyTab("tab-a", "A"),
            messages: [
              {
                id: "tool-card",
                role: "agent",
                a2ui: {
                  components: [
                    {
                      id: "restored-tool-call_1",
                      type: "tool-card",
                      props: { title: "bash", toolName: "bash" },
                      children: [
                        {
                          id: "result",
                          type: "code",
                          props: {
                            content:
                              "IN_NIX_SHELL=impure DEVSHELL_DIR=/nix/store/example",
                          },
                        },
                      ],
                    },
                  ],
                },
              },
              {
                id: "plain-copy",
                role: "agent",
                text: "IN_NIX_SHELL=impure DEVSHELL_DIR=/nix/store/example",
              },
            ],
          },
        ],
        activeTabId: "tab-a",
        savedAt: 1,
      }),
    );

    expect(parsed?.tabs[0].messages.map((message) => message.id)).toEqual([
      "tool-card",
    ]);
  });

  it("does not restore agent tabs as waiting after an app restart", () => {
    const parsed = parseSessionUiSnapshot(
      JSON.stringify({
        tabs: [
          {
            ...makeEmptyTab("tab-a", "A"),
            waiting: true,
            queueCount: 3,
            queuedMessages: [{ id: "queued", content: "next" }],
            messages: [
              { id: "m1", role: "user", text: "fix it" },
              { id: "m2", role: "agent", thinking: "Monitoring requests" },
            ],
          },
        ],
        activeTabId: "tab-a",
        savedAt: 1,
      }),
    );

    expect(parsed?.tabs[0]).toMatchObject({
      id: "tab-a",
      waiting: false,
      queueCount: 0,
      queuedMessages: [],
    });
  });

  it("preserves running agent activity for hot frontend reload snapshots", () => {
    const tab = {
      ...makeEmptyTab("tab-a", "A"),
      waiting: true,
      queueCount: 1,
      queuedMessages: [
        {
          id: "queued",
          content: "follow up",
          attachments: [
            {
              id: "img-queued",
              kind: "image" as const,
              path: "/tmp/aethon-pastes/queued.png",
              name: "queued.png",
              mimeType: "image/png",
              sizeBytes: 14,
              previewUrl: "blob:queued",
            },
          ],
        },
      ],
      messages: [
        { id: "m1", role: "user" as const, text: "fix it" },
        { id: "m2", role: "agent" as const, thinking: "Working" },
      ],
    };

    saveSessionUiSnapshot({
      tabs: [tab],
      activeTabId: "tab-a",
    });

    expect(loadSessionUiSnapshot()?.tabs[0]).toMatchObject({
      id: "tab-a",
      waiting: true,
      queueCount: 1,
      queuedMessages: [
        {
          id: "queued",
          content: "follow up",
          attachments: [
            {
              id: "img-queued",
              kind: "image",
              path: "/tmp/aethon-pastes/queued.png",
              name: "queued.png",
              mimeType: "image/png",
              sizeBytes: 14,
            },
          ],
        },
      ],
    });
  });

  it("persists shell tabs for frontend reload and restores their PTY on mount", () => {
    saveSessionUiSnapshot({
      tabs: [
        {
          ...makeEmptyTab("agent", "Agent"),
          messages: [{ id: "m1", role: "user", text: "hi" }],
        },
        {
          ...makeEmptyTab("shell", "Shell", null, "shell"),
          shell: {
            cwd: "/repo/app",
            command: "zsh",
            args: ["-l"],
            shareMode: "read",
            shellState: "running",
          },
        },
      ],
      activeTabId: "shell",
    });

    const restored = loadSessionUiSnapshot();
    expect(restored?.tabs.map((t) => t.id)).toEqual(["agent", "shell"]);
    expect(restored?.activeTabId).toBe("agent");
    expect(restored?.tabs.find((t) => t.id === "shell")?.shell).toMatchObject({
      cwd: "/repo/app",
      command: "zsh",
      args: ["-l"],
      shareMode: "read",
      shellState: "starting",
      restartOnMount: true,
    });
  });

  it("does not mark exited shell tabs for PTY restore", () => {
    const parsed = parseSessionUiSnapshot(
      JSON.stringify({
        tabs: [
          {
            ...makeEmptyTab("shell", "Shell", null, "shell"),
            shell: {
              cwd: "/repo/app",
              command: "",
              args: [],
              shareMode: "private",
              shellState: "exited",
              exitCode: 0,
            },
          },
        ],
        activeTabId: "shell",
        savedAt: 1,
      }),
    );

    expect(parsed?.activeTabId).toBe("__overview__");
    expect(parsed?.tabs[0].shell).toMatchObject({
      shellState: "exited",
      exitCode: 0,
    });
    expect(parsed?.tabs[0].shell?.restartOnMount).toBeUndefined();
  });

  it("does not auto-restart shell commands from durable disk snapshots", () => {
    const parsed = parseSessionUiSnapshot(
      JSON.stringify({
        tabs: [
          {
            ...makeEmptyTab("shell", "npm dev", null, "shell"),
            shell: {
              cwd: "/repo/app",
              command: "npm",
              args: ["run", "dev"],
              shareMode: "private",
              shellState: "running",
            },
          },
        ],
        activeTabId: "shell",
        savedAt: 1,
      }),
      { restartShellTabs: false },
    );

    expect(parsed?.tabs[0].shell).toMatchObject({
      command: "npm",
      args: ["run", "dev"],
      shellState: "exited",
      exitCode: -1,
    });
    expect(parsed?.tabs[0].shell?.restartOnMount).toBeUndefined();
  });

  it("preserves editor rootPath for files outside the active project", () => {
    const tab = {
      ...makeEmptyTab("editor", "system-prompt.md", null, "editor"),
      editor: {
        filePath: "/Users/test/.aethon/system-prompt.md",
        rootPath: "/Users/test/.aethon",
        language: "markdown",
        isDirty: true,
        cursorLine: 12,
        cursorColumn: 4,
      },
    };

    saveSessionUiSnapshot({
      tabs: [tab],
      activeTabId: "editor",
    });

    expect(loadSessionUiSnapshot()?.tabs[0]?.editor).toMatchObject({
      filePath: "/Users/test/.aethon/system-prompt.md",
      rootPath: "/Users/test/.aethon",
      language: "markdown",
      isDirty: false,
      cursorLine: 12,
      cursorColumn: 4,
    });
  });

  it("persists blank empty new tabs and keeps them active", () => {
    saveSessionUiSnapshot({
      tabs: [
        makeEmptyTab("blank", "Tab 1"),
        {
          ...makeEmptyTab("active-chat", "Tell me about this app"),
          messages: [
            { id: "m1", role: "user", text: "Tell me about this app" },
          ],
        },
      ],
      activeTabId: "blank",
    });

    const restored = loadSessionUiSnapshot();
    expect(restored?.tabs.map((t) => t.id)).toEqual(["blank", "active-chat"]);
    expect(restored?.activeTabId).toBe("blank");
  });

  it("does not persist extension-added layout columns or areas", () => {
    const tab = {
      ...makeEmptyTab("tab-a", "A"),
      messages: [{ id: "m1", role: "user" as const, text: "hi" }],
    };
    saveSessionUiSnapshot({
      tabs: [tab],
      activeTabId: "tab-a",
      layout: {
        sidebarVisible: true,
        columns: "256px minmax(0,1fr) 360px",
        areas: [
          "sidebar header header",
          "sidebar canvas gallery",
          "status status status",
        ],
      },
    });

    expect(loadSessionUiSnapshot()?.layout).toEqual({
      sidebarVisible: true,
      // Canonical 3-column shape — left + right widths round-trip
      // verbatim so the user's resize sticks.
      columns: "256px minmax(0,1fr) 360px",
    });
  });

  it("restores hidden files sidebar as a 0px track for panel animation", () => {
    const tab = {
      ...makeEmptyTab("tab-a", "A"),
      messages: [{ id: "m1", role: "user" as const, text: "hi" }],
    };
    saveSessionUiSnapshot({
      tabs: [tab],
      activeTabId: "tab-a",
      layout: {
        sidebarVisible: true,
        filesSidebarVisible: false,
        columns: "256px minmax(0,1fr)",
      },
    });

    expect(loadSessionUiSnapshot()?.layout).toMatchObject({
      filesSidebarVisible: false,
      columns: "256px minmax(0,1fr) 0px",
    });
  });

  it("bounds terminal buffers in reload snapshots", () => {
    const tab = {
      ...makeEmptyTab("tab-a", "A"),
      messages: [{ id: "m1", role: "user" as const, text: "hi" }],
    };
    const long = "x".repeat(300 * 1024);
    saveSessionUiSnapshot({
      tabs: [tab],
      activeTabId: "tab-a",
      terminal: {
        open: true,
        buffer: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`tab-${i}`, `${i}:${long}`]),
        ),
      },
    });

    const restored = loadSessionUiSnapshot();
    const buffer = (restored?.terminal as { buffer?: Record<string, string> })
      ?.buffer;
    expect(Object.keys(buffer ?? {})).toHaveLength(8);
    expect(buffer?.["tab-9"]).toHaveLength(256 * 1024);
    expect(buffer?.["tab-0"]).toBeUndefined();
  });

  it("sanitizes oversized terminal buffers from older disk snapshots on load", () => {
    const tab = {
      ...makeEmptyTab("tab-a", "A"),
      messages: [{ id: "m1", role: "user" as const, text: "hi" }],
    };
    const parsed = parseSessionUiSnapshot(
      JSON.stringify({
        tabs: [tab],
        activeTabId: "tab-a",
        terminal: {
          open: true,
          buffer: { "tab-a": "y".repeat(300 * 1024) },
        },
        savedAt: 1,
      }),
    );

    const buffer = (parsed?.terminal as { buffer?: Record<string, string> })
      ?.buffer;
    expect(buffer?.["tab-a"]).toHaveLength(256 * 1024);
  });
});
