// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskLauncher } from "./task-launcher";
import type { A2UIComponent } from "../../../types/a2ui";
import type { VoiceProviderInfo } from "../../../types/voice";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: (...args: unknown[]) => invoke(...args),
}));

function launcher(props: Record<string, unknown>): A2UIComponent {
  return {
    id: "task-launcher",
    type: "task-launcher",
    props,
  };
}

function voiceProvider(
  overrides: Partial<VoiceProviderInfo> & Pick<VoiceProviderInfo, "id">,
): VoiceProviderInfo {
  return {
    name: overrides.id,
    description: "",
    kind: "platform",
    recordingMode: "native",
    privacyLabel: "",
    offline: false,
    downloadRequired: false,
    modelSizeLabel: null,
    cachePath: null,
    acceleratorLabel: null,
    status: "ready",
    statusLabel: "Ready",
    enabled: true,
    selected: true,
    setupRequired: false,
    canRemoveModel: false,
    error: null,
    ...overrides,
    id: overrides.id,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TaskLauncher", () => {
  it("renders prompt placeholder with the project name", () => {
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "claudex", path: "/c" },
        })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    const input = screen.getByLabelText("Task prompt");
    expect(input.getAttribute("placeholder")).toBe(
      "Start a task in claudex… use @<subagent> or @path",
    );
    expect(input.getAttribute("placeholder")).not.toContain("@agent");
  });

  it("renders nothing when no project is set", () => {
    const html = renderToStaticMarkup(
      <TaskLauncher component={launcher({})} state={{}} onEvent={() => {}} />,
    );
    expect(html).toBe("");
  });

  it("omits the project chip on per-project launchers", () => {
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/a" },
          otherProjects: [{ id: "p2", label: "koban", path: "/k" }],
        })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Project" })).toBeNull();
    expect(screen.getByRole("button", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  });

  it("shows a local project selector for host-level launchers", async () => {
    const onEvent = vi.fn();
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/a" },
          projects: [
            { id: "p1", label: "aethon", path: "/a" },
            { id: "p2", label: "koban", path: "/k" },
          ],
          workspacesByProject: {
            p2: [{ id: "k-main", label: "main", path: "/k" }],
          },
          showProjectSelector: true,
        })}
        state={{}}
        onEvent={onEvent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "koban" }));
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        "start-task",
        expect.objectContaining({
          projectId: "p2",
          prompt: "ship it",
        }),
      ),
    );
  });

  it("resets workspace and base branch when a host-level selected project disappears", async () => {
    const onEvent = vi.fn();
    const { rerender } = render(
      <TaskLauncher
        component={launcher({
          project: {
            id: "p1",
            label: "aethon",
            path: "/a",
            workspaceBaseBranch: "trunk",
          },
          projects: [
            {
              id: "p1",
              label: "aethon",
              path: "/a",
              workspaceBaseBranch: "trunk",
            },
            {
              id: "p2",
              label: "koban",
              path: "/k",
              workspaceBaseBranch: "release",
            },
          ],
          showProjectSelector: true,
        })}
        state={{}}
        onEvent={onEvent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "koban" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "+ New workspace" }));
    expect(
      screen.getByLabelText<HTMLInputElement>(
        "Base branch (empty = project default)",
      ).value,
    ).toBe("release");

    rerender(
      <TaskLauncher
        component={launcher({
          project: {
            id: "p1",
            label: "aethon",
            path: "/a",
            workspaceBaseBranch: "trunk",
          },
          projects: [
            {
              id: "p1",
              label: "aethon",
              path: "/a",
              workspaceBaseBranch: "trunk",
            },
          ],
          showProjectSelector: true,
        })}
        state={{}}
        onEvent={onEvent}
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByLabelText("Base branch (empty = project default)"),
      ).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "+ New workspace" }));
    expect(
      screen.getByLabelText<HTMLInputElement>(
        "Base branch (empty = project default)",
      ).value,
    ).toBe("trunk");
    fireEvent.change(screen.getByLabelText("New branch name"), {
      target: { value: "codex/check-selector" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        "start-task",
        expect.objectContaining({
          projectId: "p1",
          branch: "codex/check-selector",
          baseBranch: "trunk",
        }),
      ),
    );
  });

  it("renders the voice input control on the overview task launcher", () => {
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/a" },
        })}
        state={{}}
        onEvent={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Voice input" })).toBeTruthy();
  });

  it("inserts a voice transcript into the task prompt and submits it", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "voice_list_providers") {
        return Promise.resolve([
          voiceProvider({ id: "voice-platform-system" }),
        ]);
      }
      if (cmd === "voice_start_recording") return Promise.resolve(undefined);
      if (cmd === "voice_stop_and_transcribe") {
        return Promise.resolve("review the open issues");
      }
      return Promise.reject(new Error(`invoke not mocked: ${cmd}`));
    });
    const onEvent = vi.fn();
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/a" },
        })}
        state={{}}
        onEvent={onEvent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Voice input" }));
    await screen.findByRole("button", { name: "Stop voice input" });
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));

    await waitFor(() =>
      expect(
        screen.getByLabelText<HTMLTextAreaElement>("Task prompt").value,
      ).toBe("review the open issues"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        "start-task",
        expect.objectContaining({
          projectId: "p1",
          prompt: "review the open issues",
        }),
      ),
    );
  });

  // The dashboard task-launcher and the composer both stay mounted (the layout
  // grid toggles display:none), each registering the same global voice hotkey
  // against one shared mic. The launcher must ignore the hotkey while its
  // dashboard is hidden, otherwise pressing it fires both surfaces and the
  // loser reports "Voice recording is already active".
  it("ignores the voice hotkey while its dashboard is hidden", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "voice_list_providers") {
        return Promise.resolve([
          voiceProvider({ id: "voice-platform-system" }),
        ]);
      }
      if (cmd === "voice_start_recording") return Promise.resolve(undefined);
      return Promise.reject(new Error(`invoke not mocked: ${cmd}`));
    });
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/a" },
        })}
        state={{ emptyAndProject: false }}
        onEvent={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.keyDown(window, {
        key: "m",
        code: "KeyM",
        metaKey: true,
        shiftKey: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(invoke).not.toHaveBeenCalledWith(
      "voice_list_providers",
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "voice_start_recording",
      expect.anything(),
    );
  });

  it("starts recording from the voice hotkey while its dashboard is visible", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "voice_list_providers") {
        return Promise.resolve([
          voiceProvider({ id: "voice-platform-system" }),
        ]);
      }
      if (cmd === "voice_start_recording") return Promise.resolve(undefined);
      return Promise.reject(new Error(`invoke not mocked: ${cmd}`));
    });
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/a" },
        })}
        state={{ emptyAndProject: true }}
        onEvent={vi.fn()}
      />,
    );

    act(() => {
      fireEvent.keyDown(window, {
        key: "m",
        code: "KeyM",
        metaKey: true,
        shiftKey: true,
      });
    });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("voice_start_recording", {
        providerId: "voice-platform-system",
      }),
    );
    await screen.findByRole("button", { name: "Stop voice input" });
  });

  it("disables OS autocorrection on branch inputs", () => {
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/a" },
        })}
        state={{}}
        onEvent={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "+ New workspace" }));

    for (const input of [
      screen.getByLabelText("New branch name"),
      screen.getByLabelText("Base branch (empty = project default)"),
    ]) {
      expect(input.getAttribute("autocapitalize")).toBe("none");
      expect(input.getAttribute("autocorrect")).toBe("off");
      expect(input.getAttribute("spellcheck")).toBe("false");
    }
  });

  it("offers @file completions rooted at the project and inserts on Tab", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "fs_walk_project"
        ? Promise.resolve(["/repo/aethon/src/App.tsx"])
        : cmd === "subagents_list"
          ? Promise.resolve([])
          : Promise.reject(new Error(`invoke not mocked: ${cmd}`)),
    );
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/repo/aethon" },
        })}
        state={{}}
        onEvent={vi.fn()}
      />,
    );

    const prompt = screen.getByLabelText("Task prompt");
    fireEvent.change(prompt, { target: { value: "@app" } });

    await screen.findByText("App.tsx");
    expect(invoke).toHaveBeenCalledWith("fs_walk_project", {
      root: "/repo/aethon",
    });

    fireEvent.keyDown(prompt, { key: "Tab" });
    expect((prompt as HTMLTextAreaElement).value).toBe("@src/App.tsx ");
  });

  it("offers leading subagent completions rooted at the project", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "fs_walk_project"
        ? Promise.resolve([])
        : cmd === "subagents_list"
          ? Promise.resolve([
              {
                scope: "project",
                name: "kimi",
                filePath: "/repo/aethon/.aethon/agents/kimi.md",
                content:
                  "---\ndescription: Reviews code with Kimi.\nsurface: tab\n---\nYou review code.\n",
              },
            ])
          : Promise.reject(new Error(`invoke not mocked: ${cmd}`)),
    );
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/repo/aethon" },
        })}
        state={{}}
        onEvent={vi.fn()}
      />,
    );

    const prompt = screen.getByLabelText("Task prompt");
    fireEvent.change(prompt, { target: { value: "@ki" } });

    await screen.findByText("@kimi");
    expect(invoke).toHaveBeenCalledWith("subagents_list", {
      projectRoot: "/repo/aethon",
    });

    fireEvent.keyDown(prompt, { key: "Tab" });
    expect((prompt as HTMLTextAreaElement).value).toBe("@kimi ");
  });

  it("allows a new workspace session with an automatic branch", async () => {
    const onEvent = vi.fn();
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/repo/aethon" },
        })}
        state={{}}
        onEvent={onEvent}
      />,
    );

    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "start this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "+ New workspace" }));

    const start = screen.getByRole("button", { name: "Start" });
    expect(start.hasAttribute("disabled")).toBe(false);
    fireEvent.click(start);

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        "start-task",
        expect.objectContaining({
          projectId: "p1",
          prompt: "start this",
          newWorkspace: true,
          branch: "",
        }),
      ),
    );
  });

  it("resolves project via $ref", () => {
    const html = renderToStaticMarkup(
      <TaskLauncher
        component={launcher({ project: { $ref: "/project" } })}
        state={{ project: { id: "p1", label: "mold", path: "/m" } }}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain("mold");
    expect(html).toContain("Start a task in mold…");
  });

  it("dismisses chip menus on Escape and focus outside", () => {
    render(
      <>
        <TaskLauncher
          component={launcher({
            project: { id: "p1", label: "aethon", path: "/a" },
            workspaces: [{ id: "wt-1", label: "main", path: "/a-wt" }],
          })}
          state={{}}
          onEvent={() => {}}
        />
        <button type="button">outside</button>
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.getByRole("menu").textContent).toContain("main");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.focusIn(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("pastes image attachments into the task launcher and submits them", async () => {
    invoke.mockResolvedValue("/tmp/aethon-pastes/pasted.png");
    const onEvent = vi.fn();
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/a" },
        })}
        state={{}}
        onEvent={onEvent}
      />,
    );
    const input = screen.getByLabelText("Task prompt");
    const file = new File(["abc"], "shot.png", { type: "image/png" });
    fireEvent.paste(input, {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => file,
          },
        ],
      },
    });

    await screen.findByText("shot.png");
    fireEvent.click(screen.getByRole("button", { name: "Open shot.png" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        "start-task",
        expect.objectContaining({
          projectId: "p1",
          prompt: "",
          attachments: [
            expect.objectContaining({
              name: "shot.png",
              path: "/tmp/aethon-pastes/pasted.png",
              mimeType: "image/png",
            }),
          ],
        }),
      ),
    );
  });

  it("emits an event when pasted image persistence fails", async () => {
    invoke.mockRejectedValue(new Error("payload exceeds 32 MiB"));
    const onEvent = vi.fn();
    render(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/a" },
        })}
        state={{}}
        onEvent={onEvent}
      />,
    );
    const input = screen.getByLabelText("Task prompt");
    const file = new File(["abc"], "huge.png", { type: "image/png" });
    fireEvent.paste(input, {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => file,
          },
        ],
      },
    });

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith("paste-image-failed", {
        message: "payload exceeds 32 MiB",
      }),
    );
    expect(screen.queryByText("huge.png")).toBeNull();
  });
});
