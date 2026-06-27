// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionRegistry } from "../extensions/ExtensionRegistry";
import type { ProjectsState } from "../projects";
import { useAppSlashCommandContext } from "./useAppSlashCommandContext";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

const ref = <T>(value: T) => ({ current: value });

function makeProjects(): ProjectsState {
  return {
    projects: [
      {
        id: "project-1",
        label: "Aethon",
        path: "/repo/aethon",
        lastUsed: 1,
      },
    ],
    activeId: "project-1",
    activeWorkspaceId: null,
    workspacesByProject: {},
    activeHostId: null,
  };
}

describe("useAppSlashCommandContext", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("persists slash command system output to the active tab", () => {
    const appendMessage = vi.fn();
    const { result } = renderHook(() =>
      useAppSlashCommandContext({
        bootLayout: { components: [] },
        setState: vi.fn(),
        setLayout: vi.fn(),
        stateRef: ref({ activeTabId: "tab-1" }),
        projectsRef: ref(makeProjects()),
        layoutCatalogueRef: ref([
          {
            id: "workstation",
            name: "Workstation",
            payload: { components: [] },
          },
        ]),
        registry: new ExtensionRegistry(),
        appendMessage,
        pushNotification: vi.fn(() => "toast-1"),
        clearChat: vi.fn(),
        setTheme: vi.fn(),
        listThemes: vi.fn(() => []),
        setModel: vi.fn(() => Promise.resolve()),
        toggleTerminal: vi.fn(),
        toggleSidebar: vi.fn(),
        toggleFilesSidebar: vi.fn(),
        activateLayoutById: vi.fn(() => true),
        openProjectFromPicker: vi.fn(() => Promise.resolve(null)),
        openProjectByPath: vi.fn((path: string) => path),
        setActiveProjectById: vi.fn(() => true),
        clearActiveProject: vi.fn(),
        removeProjectById: vi.fn(() => true),
      }),
    );

    act(() => {
      result.current.slashContext().appendSystem("Theme set to Paper.");
    });

    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        text: "Theme set to Paper.",
        createdAt: expect.any(Number),
      }),
      "tab-1",
    );
    const payload = JSON.parse(invokeMock.mock.calls[0]?.[1]?.payload);
    expect(payload).toMatchObject({
      type: "local_chat_message",
      tabId: "tab-1",
      payload: {
        role: "system",
        text: "Theme set to Paper.",
        createdAt: expect.any(Number),
      },
    });
  });

  it("keeps slash command follow-up output on the invoking tab", () => {
    const appendMessage = vi.fn();
    const stateRef = ref({
      activeTabId: "tab-1",
      tabs: [
        { id: "tab-1", kind: "agent", label: "One" },
        { id: "tab-2", kind: "agent", label: "Two" },
      ],
    });
    const { result } = renderHook(() =>
      useAppSlashCommandContext({
        bootLayout: { components: [] },
        setState: vi.fn(),
        setLayout: vi.fn(),
        stateRef,
        projectsRef: ref(makeProjects()),
        layoutCatalogueRef: ref([]),
        registry: new ExtensionRegistry(),
        appendMessage,
        pushNotification: vi.fn(() => "toast-1"),
        clearChat: vi.fn(),
        setTheme: vi.fn(),
        listThemes: vi.fn(() => []),
        setModel: vi.fn(() => Promise.resolve()),
        toggleTerminal: vi.fn(),
        toggleSidebar: vi.fn(),
        toggleFilesSidebar: vi.fn(),
        activateLayoutById: vi.fn(() => true),
        openProjectFromPicker: vi.fn(() => Promise.resolve(null)),
        openProjectByPath: vi.fn((path: string) => path),
        setActiveProjectById: vi.fn(() => true),
        clearActiveProject: vi.fn(),
        removeProjectById: vi.fn(() => true),
      }),
    );

    const ctx = result.current.slashContext({ tabId: "tab-1" });
    stateRef.current.activeTabId = "tab-2";

    act(() => {
      ctx.appendSystem("MCP servers");
    });

    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        text: "MCP servers",
      }),
      "tab-1",
    );
    const payload = JSON.parse(invokeMock.mock.calls[0]?.[1]?.payload);
    expect(payload).toMatchObject({
      type: "local_chat_message",
      tabId: "tab-1",
    });
  });

  it("uses the active workspace as the project root when the invoking tab has no cwd", () => {
    const projects = makeProjects();
    projects.activeWorkspaceId = "wt-1";
    projects.workspacesByProject = {
      "project-1": [
        {
          id: "wt-1",
          projectId: "project-1",
          label: "feature-worktree",
          path: "/repo/aethon-worktree",
          isMain: false,
          branch: "feature/worktree",
        },
      ],
    };
    const { result } = renderHook(() =>
      useAppSlashCommandContext({
        bootLayout: { components: [] },
        setState: vi.fn(),
        setLayout: vi.fn(),
        stateRef: ref({
          activeTabId: "tab-1",
          tabs: [{ id: "tab-1", kind: "agent", label: "One" }],
        }),
        projectsRef: ref(projects),
        layoutCatalogueRef: ref([]),
        registry: new ExtensionRegistry(),
        appendMessage: vi.fn(),
        pushNotification: vi.fn(() => "toast-1"),
        clearChat: vi.fn(),
        setTheme: vi.fn(),
        listThemes: vi.fn(() => []),
        setModel: vi.fn(() => Promise.resolve()),
        toggleTerminal: vi.fn(),
        toggleSidebar: vi.fn(),
        toggleFilesSidebar: vi.fn(),
        activateLayoutById: vi.fn(() => true),
        openProjectFromPicker: vi.fn(() => Promise.resolve(null)),
        openProjectByPath: vi.fn((path: string) => path),
        setActiveProjectById: vi.fn(() => true),
        clearActiveProject: vi.fn(),
        removeProjectById: vi.fn(() => true),
      }),
    );

    expect(result.current.slashContext().activeProjectRoot?.()).toBe(
      "/repo/aethon-worktree",
    );
  });

  it("carries the invoking tab cwd when forwarding native slash commands", async () => {
    const { result } = renderHook(() =>
      useAppSlashCommandContext({
        bootLayout: { components: [] },
        setState: vi.fn(),
        setLayout: vi.fn(),
        stateRef: ref({
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              kind: "agent",
              label: "One",
              cwd: "/repo/aethon-worktree",
            },
          ],
        }),
        projectsRef: ref(makeProjects()),
        layoutCatalogueRef: ref([]),
        registry: new ExtensionRegistry(),
        appendMessage: vi.fn(),
        pushNotification: vi.fn(() => "toast-1"),
        clearChat: vi.fn(),
        setTheme: vi.fn(),
        listThemes: vi.fn(() => []),
        setModel: vi.fn(() => Promise.resolve()),
        toggleTerminal: vi.fn(),
        toggleSidebar: vi.fn(),
        toggleFilesSidebar: vi.fn(),
        activateLayoutById: vi.fn(() => true),
        openProjectFromPicker: vi.fn(() => Promise.resolve(null)),
        openProjectByPath: vi.fn((path: string) => path),
        setActiveProjectById: vi.fn(() => true),
        clearActiveProject: vi.fn(),
        removeProjectById: vi.fn(() => true),
      }),
    );

    await act(async () => {
      await result.current.slashContext().runNativeCommand("mcp", "tools");
    });

    expect(invokeMock).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "native_slash_command",
        tabId: "tab-1",
        name: "mcp",
        args: "tools",
        cwd: "/repo/aethon-worktree",
      }),
    });
  });

  it("carries the active workspace cwd for native slash commands when the tab has no cwd", async () => {
    const projects = makeProjects();
    projects.activeWorkspaceId = "wt-1";
    projects.workspacesByProject = {
      "project-1": [
        {
          id: "wt-1",
          projectId: "project-1",
          label: "feature-worktree",
          path: "/repo/aethon-worktree",
          isMain: false,
          branch: "feature/worktree",
        },
      ],
    };
    const { result } = renderHook(() =>
      useAppSlashCommandContext({
        bootLayout: { components: [] },
        setState: vi.fn(),
        setLayout: vi.fn(),
        stateRef: ref({
          activeTabId: "tab-1",
          tabs: [{ id: "tab-1", kind: "agent", label: "One" }],
        }),
        projectsRef: ref(projects),
        layoutCatalogueRef: ref([]),
        registry: new ExtensionRegistry(),
        appendMessage: vi.fn(),
        pushNotification: vi.fn(() => "toast-1"),
        clearChat: vi.fn(),
        setTheme: vi.fn(),
        listThemes: vi.fn(() => []),
        setModel: vi.fn(() => Promise.resolve()),
        toggleTerminal: vi.fn(),
        toggleSidebar: vi.fn(),
        toggleFilesSidebar: vi.fn(),
        activateLayoutById: vi.fn(() => true),
        openProjectFromPicker: vi.fn(() => Promise.resolve(null)),
        openProjectByPath: vi.fn((path: string) => path),
        setActiveProjectById: vi.fn(() => true),
        clearActiveProject: vi.fn(),
        removeProjectById: vi.fn(() => true),
      }),
    );

    await act(async () => {
      await result.current.slashContext().runNativeCommand("mcp", "tools");
    });

    expect(invokeMock).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "native_slash_command",
        tabId: "tab-1",
        name: "mcp",
        args: "tools",
        cwd: "/repo/aethon-worktree",
      }),
    });
  });

  it("does not persist empty local chat messages", () => {
    const { result } = renderHook(() =>
      useAppSlashCommandContext({
        bootLayout: { components: [] },
        setState: vi.fn(),
        setLayout: vi.fn(),
        stateRef: ref({}),
        projectsRef: ref(makeProjects()),
        layoutCatalogueRef: ref([]),
        registry: new ExtensionRegistry(),
        appendMessage: vi.fn(),
        pushNotification: vi.fn(() => "toast-1"),
        clearChat: vi.fn(),
        setTheme: vi.fn(),
        listThemes: vi.fn(() => []),
        setModel: vi.fn(() => Promise.resolve()),
        toggleTerminal: vi.fn(),
        toggleSidebar: vi.fn(),
        toggleFilesSidebar: vi.fn(),
        activateLayoutById: vi.fn(() => true),
        openProjectFromPicker: vi.fn(() => Promise.resolve(null)),
        openProjectByPath: vi.fn((path: string) => path),
        setActiveProjectById: vi.fn(() => true),
        clearActiveProject: vi.fn(),
        removeProjectById: vi.fn(() => true),
      }),
    );

    act(() => {
      result.current.persistLocalChatMessage(
        { id: "m1", role: "system" },
        "tab-1",
      );
    });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("persists a2ui payloads and honors their creation timestamp", () => {
    const { result } = renderHook(() =>
      useAppSlashCommandContext({
        bootLayout: { components: [] },
        setState: vi.fn(),
        setLayout: vi.fn(),
        stateRef: ref({}),
        projectsRef: ref(makeProjects()),
        layoutCatalogueRef: ref([]),
        registry: new ExtensionRegistry(),
        appendMessage: vi.fn(),
        pushNotification: vi.fn(() => "toast-1"),
        clearChat: vi.fn(),
        setTheme: vi.fn(),
        listThemes: vi.fn(() => []),
        setModel: vi.fn(() => Promise.resolve()),
        toggleTerminal: vi.fn(),
        toggleSidebar: vi.fn(),
        toggleFilesSidebar: vi.fn(),
        activateLayoutById: vi.fn(() => true),
        openProjectFromPicker: vi.fn(() => Promise.resolve(null)),
        openProjectByPath: vi.fn((path: string) => path),
        setActiveProjectById: vi.fn(() => true),
        clearActiveProject: vi.fn(),
        removeProjectById: vi.fn(() => true),
      }),
    );

    const a2ui = {
      components: [
        {
          id: "tool-1",
          type: "tool-card",
          props: { toolName: "bash", startedAt: 1_000 },
        },
      ],
    };
    act(() => {
      result.current.persistLocalChatMessage(
        { id: "tool-1", role: "agent", a2ui, createdAt: 1_000 },
        "tab-1",
      );
    });

    const payload = JSON.parse(invokeMock.mock.calls[0]?.[1]?.payload);
    expect(payload.payload).toMatchObject({
      id: "tool-1",
      role: "agent",
      a2ui,
      createdAt: 1_000,
    });
  });

  it("persists image attachment metadata without blob preview URLs", () => {
    const { result } = renderHook(() =>
      useAppSlashCommandContext({
        bootLayout: { components: [] },
        setState: vi.fn(),
        setLayout: vi.fn(),
        stateRef: ref({}),
        projectsRef: ref(makeProjects()),
        layoutCatalogueRef: ref([]),
        registry: new ExtensionRegistry(),
        appendMessage: vi.fn(),
        pushNotification: vi.fn(() => "toast-1"),
        clearChat: vi.fn(),
        setTheme: vi.fn(),
        listThemes: vi.fn(() => []),
        setModel: vi.fn(() => Promise.resolve()),
        toggleTerminal: vi.fn(),
        toggleSidebar: vi.fn(),
        toggleFilesSidebar: vi.fn(),
        activateLayoutById: vi.fn(() => true),
        openProjectFromPicker: vi.fn(() => Promise.resolve(null)),
        openProjectByPath: vi.fn((path: string) => path),
        setActiveProjectById: vi.fn(() => true),
        clearActiveProject: vi.fn(),
        removeProjectById: vi.fn(() => true),
      }),
    );

    act(() => {
      result.current.persistLocalChatMessage(
        {
          id: "m1",
          role: "user",
          attachments: [
            {
              id: "img-1",
              kind: "image",
              path: "/tmp/aethon-pastes/one.png",
              name: "one.png",
              mimeType: "image/png",
              sizeBytes: 12,
              previewUrl: "blob:temp",
            },
          ],
        },
        "tab-1",
      );
    });

    const payload = JSON.parse(invokeMock.mock.calls[0]?.[1]?.payload);
    expect(payload.payload.attachments).toEqual([
      {
        id: "img-1",
        kind: "image",
        path: "/tmp/aethon-pastes/one.png",
        name: "one.png",
        mimeType: "image/png",
        sizeBytes: 12,
      },
    ]);
  });

  it("login `use` switches a worker tab via both use_for_tab and apply", async () => {
    const { result } = renderHook(() =>
      useAppSlashCommandContext({
        bootLayout: { components: [] },
        setState: vi.fn(),
        setLayout: vi.fn(),
        stateRef: ref({
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              kind: "agent",
              cwd: "/repo",
              model: "openai-codex/gpt-5.5",
              waiting: false,
              messages: [],
              queueCount: 0,
              queuedMessages: [],
            },
          ],
          authProfiles: {
            profiles: [
              {
                id: "openai-codex-secondary",
                label: "Secondary",
                providerId: "openai-codex",
                kind: "oauth",
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        }),
        projectsRef: ref(makeProjects()),
        layoutCatalogueRef: ref([]),
        registry: new ExtensionRegistry(),
        appendMessage: vi.fn(),
        pushNotification: vi.fn(() => "toast-1"),
        clearChat: vi.fn(),
        setTheme: vi.fn(),
        listThemes: vi.fn(() => []),
        setModel: vi.fn(() => Promise.resolve()),
        toggleTerminal: vi.fn(),
        toggleSidebar: vi.fn(),
        toggleFilesSidebar: vi.fn(),
        activateLayoutById: vi.fn(() => true),
        openProjectFromPicker: vi.fn(() => Promise.resolve(null)),
        openProjectByPath: vi.fn((path: string) => path),
        setActiveProjectById: vi.fn(() => true),
        clearActiveProject: vi.fn(),
        removeProjectById: vi.fn(() => true),
      }),
    );

    await act(async () => {
      await result.current
        .slashContext()
        .useAuthProfile("openai-codex-secondary");
    });

    // A worker tab needs both the global mapping AND the tab-scoped worker
    // re-auth; use_for_tab alone would leave the worker on the old account.
    expect(invokeMock).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "auth_profile_use_for_tab",
        tabId: "tab-1",
        profileId: "openai-codex-secondary",
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "auth_profile_apply",
        tabId: "tab-1",
        profileId: "openai-codex-secondary",
        cwd: "/repo",
        model: "openai-codex/gpt-5.5",
      }),
    });
  });
});
