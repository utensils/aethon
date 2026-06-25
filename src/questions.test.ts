import { describe, expect, it } from "vitest";
import { createQuestionMessage } from "./questions";

describe("createQuestionMessage", () => {
  it("includes visible fallback text for question-backed chat rows", () => {
    const message = createQuestionMessage(
      {
        title: "MCP setup",
        prompt: "Project: `/repo/app`\nState: approved\nSources: `.mcp.json`",
        choices: [{ id: "status", label: "Show status" }],
      },
      "mcp-setup",
      "question-message-mcp-setup",
    );

    expect(message).toMatchObject({
      id: "question-message-mcp-setup",
      role: "system",
      text: "## MCP setup\nProject: `/repo/app`\nState: approved\nSources: `.mcp.json`",
    });
    expect(message.a2ui?.components[0]).toMatchObject({
      type: "question-card",
      props: {
        questionId: "mcp-setup",
        title: "MCP setup",
      },
    });
  });

  it("records the selected answer in fallback text", () => {
    const message = createQuestionMessage(
      {
        title: "MCP setup",
        prompt: "State: approved",
        choices: [{ id: "status", label: "Show status" }],
      },
      "mcp-setup",
      "question-message-mcp-setup",
      {
        questionId: "mcp-setup",
        choiceId: "status",
        label: "Show status",
      },
    );

    expect(message.text).toBe(
      "## MCP setup\nState: approved\nSelected: Show status",
    );
  });
});
