import { describe, expect, it } from "vitest";
import {
  isRunningToolCard,
  isToolCardMessage,
  summarizeToolMessages,
  toolCardFileChange,
  toolCardTitle,
} from "./toolCardGrouping";
import type { ChatMessage } from "../types/a2ui";

function text(id: string, role: ChatMessage["role"] = "agent"): ChatMessage {
  return { id, role, text: `msg ${id}` };
}

function tool(id: string, props: Record<string, unknown> = {}): ChatMessage {
  return {
    id,
    role: "agent",
    a2ui: {
      components: [
        {
          id: `c-${id}`,
          type: "tool-card",
          props: { title: "bash", startedAt: 1, endedAt: 2, ...props },
        },
      ],
    },
  };
}

describe("tool card metadata", () => {
  it("detects tool cards, titles, and running state", () => {
    expect(isToolCardMessage(tool("a"))).toBe(true);
    expect(isToolCardMessage(text("a"))).toBe(false);
    expect(toolCardTitle(tool("a"))).toBe("bash");
    expect(isRunningToolCard(tool("run", { endedAt: undefined }))).toBe(true);
    expect(isRunningToolCard(tool("done"))).toBe(false);
    expect(isRunningToolCard(text("a"))).toBe(false);
  });

  it("reads normalized file-change metadata", () => {
    const message = tool("edit", {
      fileChange: {
        kind: "created",
        path: "src/new.ts",
        rootPath: "/repo",
        preview: "+export const ok = true;",
        additions: 1,
        deletions: 0,
      },
    });

    expect(toolCardFileChange(message)).toEqual({
      kind: "created",
      path: "src/new.ts",
      rootPath: "/repo",
      preview: "+export const ok = true;",
      additions: 1,
      deletions: 0,
    });
  });

  it("refreshes cached metadata when restored file-change fields arrive later", () => {
    const message = tool("edit", {
      fileChange: {
        kind: "edited",
        path: "src/App.tsx",
        additions: 15,
      },
    });

    expect(toolCardFileChange(message)).toEqual({
      kind: "edited",
      path: "src/App.tsx",
      additions: 15,
    });

    const props = message.a2ui?.components?.[0]?.props;
    if (!props) throw new Error("expected tool-card props");
    const fileChange = props.fileChange as Record<string, unknown>;
    fileChange.rootPath = "/repo/aethon";
    delete fileChange.additions;
    fileChange.deletions = 2;

    expect(toolCardFileChange(message)).toEqual({
      kind: "edited",
      path: "src/App.tsx",
      rootPath: "/repo/aethon",
      deletions: 2,
    });
  });
});

describe("summarizeToolMessages", () => {
  it("summarizes status, duration, unique names, and file changes", () => {
    const summary = summarizeToolMessages([
      tool("read", { title: "read", startedAt: 1_000, endedAt: 2_500 }),
      tool("bash", {
        title: "bash",
        startedAt: 3_000,
        endedAt: 7_000,
        isError: true,
      }),
      tool("edit", {
        title: "edit",
        startedAt: 8_000,
        endedAt: 9_000,
        fileChange: {
          kind: "edited",
          path: "src/App.tsx",
          additions: 12,
          deletions: 3,
        },
      }),
      tool("write", {
        title: "write",
        startedAt: 10_000,
        endedAt: 11_000,
        fileChange: {
          kind: "created",
          path: "src/new.ts",
          additions: 5,
        },
      }),
      tool("cancelled", { status: "cancelled" }),
      text("not-a-tool"),
    ]);

    expect(summary).toEqual({
      total: 5,
      running: 0,
      failed: 1,
      cancelled: 1,
      durationMs: 7_501,
      names: ["read", "bash", "edit", "write"],
      fileChanges: {
        total: 2,
        created: 1,
        edited: 1,
        additions: 17,
        deletions: 3,
      },
    });
  });

  it("counts running cards without adding open-ended duration", () => {
    const summary = summarizeToolMessages([
      tool("running", { title: "bash", startedAt: 1_000, endedAt: undefined }),
    ]);

    expect(summary.total).toBe(1);
    expect(summary.running).toBe(1);
    expect(summary.durationMs).toBe(0);
    expect(summary.names).toEqual(["bash"]);
  });
});
