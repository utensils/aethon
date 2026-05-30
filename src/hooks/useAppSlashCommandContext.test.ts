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
    activeWorktreeId: null,
    worktreesByProject: {},
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
      },
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
});
