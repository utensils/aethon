// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import {
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

  it("renders the project chip label and start button", () => {
    const html = renderToStaticMarkup(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/a" },
        })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain("aethon");
    expect(html).toContain("Start");
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
