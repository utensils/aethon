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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TaskLauncher", () => {
  it("renders prompt placeholder with the project name", () => {
    const html = renderToStaticMarkup(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "claudex", path: "/c" },
        })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain("Start a task in claudex…");
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
            worktrees: [{ id: "wt-1", label: "main", path: "/a-wt" }],
          })}
          state={{}}
          onEvent={() => {}}
        />
        <button type="button">outside</button>
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Worktree" }));
    expect(screen.getByRole("menu").textContent).toContain("main");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Worktree" }));
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
});
