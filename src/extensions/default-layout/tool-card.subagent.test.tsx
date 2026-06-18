// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentResult, ToolCard } from "./tool-card";
import type { A2UIComponent } from "../../types/a2ui";

afterEach(cleanup);

function taskCard(state: Record<string, unknown>) {
  const component: A2UIComponent = {
    id: "tool-3-call-abc",
    type: "tool-card",
    props: { title: "task", toolName: "task", startedAt: 1 },
  };
  render(<ToolCard component={component} state={state} onEvent={() => {}} />);
}

describe("ToolCard subagent activity", () => {
  it("renders the subagent timeline for a running task card", () => {
    taskCard({
      subagentProgress: {
        "call-abc": {
          subagent: "reviewer",
          model: "ollama/llama3.3",
          steps: [
            { kind: "tool", label: "read src/foo.ts" },
            { kind: "error", label: "boom" },
          ],
          text: "working on it",
          done: false,
        },
      },
    });
    expect(screen.getByText(/reviewer/)).toBeTruthy();
    expect(screen.getByText("read src/foo.ts")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByText("working on it")).toBeTruthy();
  });

  it("shows no activity block when there's no progress for the card", () => {
    taskCard({ subagentProgress: {} });
    expect(screen.queryByText("read src/foo.ts")).toBeNull();
  });

  it("keeps streamed subagent text visible after completion", () => {
    taskCard({
      subagentProgress: {
        "call-abc": {
          subagent: "reviewer",
          model: "ollama/llama3.3",
          steps: [],
          text: "final summary",
          done: true,
        },
      },
    });
    expect(screen.getByText("final summary")).toBeTruthy();
  });

  it("renders multiple subagent activity blocks for batch progress", () => {
    taskCard({
      subagentProgress: {
        "call-abc": {
          kind: "batch",
          order: ["0:kimi", "1:glm"],
          items: {
            "0:kimi": {
              subagent: "kimi",
              model: "m1",
              steps: [{ kind: "tool", label: "read src/a.ts" }],
              text: "kimi notes",
              done: false,
            },
            "1:glm": {
              subagent: "glm",
              model: "m2",
              steps: [],
              text: "glm notes",
              done: true,
            },
          },
        },
      },
    });
    expect(screen.getAllByText(/kimi/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/glm/).length).toBeGreaterThan(0);
    expect(screen.getByText("read src/a.ts")).toBeTruthy();
    expect(screen.getByText("kimi notes")).toBeTruthy();
    expect(screen.getByText("glm notes")).toBeTruthy();
  });

  it("renders task result output as prose", () => {
    render(
      <SubagentResult
        component={{
          id: "r1",
          type: "subagent-result",
          props: { content: "Line one\nLine two" },
        }}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(screen.getByText(/Line one/)).toBeTruthy();
  });
});

describe("ToolCard file changes", () => {
  it("renders and expands an edited file preview", () => {
    render(
      <ToolCard
        component={{
          id: "tool-edit",
          type: "tool-card",
          props: {
            title: "edit",
            toolName: "edit",
            startedAt: 1,
            endedAt: 2,
            fileChange: {
              kind: "edited",
              path: "src/App.tsx",
              rootPath: "/repo",
              preview: "--- a/src/App.tsx\n+++ b/src/App.tsx\n-old\n+new",
              additions: 1,
              deletions: 1,
            },
          },
        }}
        state={{}}
        onEvent={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Edited 1 file"));

    expect(screen.getByText("App.tsx")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
    expect(screen.getByText("+new")).toBeTruthy();
  });

  it("emits file open and diff actions", () => {
    const onEvent = vi.fn();
    render(
      <ToolCard
        component={{
          id: "tool-write",
          type: "tool-card",
          props: {
            title: "write",
            toolName: "write",
            fileChange: {
              kind: "created",
              path: "src/new.ts",
              rootPath: "/repo",
              preview: "+export const ok = true;",
              additions: 1,
            },
          },
        }}
        state={{}}
        onEvent={onEvent}
      />,
    );

    fireEvent.click(screen.getByText("Created 1 file"));
    fireEvent.click(screen.getByTitle("Open src/new.ts"));
    expect(onEvent).toHaveBeenCalledWith("tool-file-open", {
      filePath: "src/new.ts",
      rootPath: "/repo",
    });

    fireEvent.click(screen.getByRole("button", { name: "Open diff for new.ts" }));
    expect(onEvent).toHaveBeenCalledWith("tool-file-diff", {
      filePath: "src/new.ts",
      rootPath: "/repo",
    });
  });
});
