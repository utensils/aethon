// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolCard } from "./tool-card";
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
});
