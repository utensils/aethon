import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/a2ui";
import { summarizeToolMessages } from "../../utils/toolCardGrouping";
import {
  activityLabel,
  collectFileChangeEntries,
  compactDuration,
  fileChangeLabel,
  lineTone,
  liveActivitySummary,
  previewLines,
  summaryWithFileEntries,
} from "./tool-activity-summary";

function toolMessage(
  id: string,
  fileChange: Record<string, unknown>,
): ChatMessage {
  return {
    id,
    role: "agent",
    a2ui: {
      components: [
        {
          id: `tool-${id}`,
          type: "tool-card",
          props: {
            title: "edit",
            status: "completed",
            startedAt: 1000,
            endedAt: 2000,
            fileChange,
          },
        },
      ],
    },
  };
}

describe("tool activity summary helpers", () => {
  it("formats compact durations", () => {
    expect(compactDuration(0)).toBe("");
    expect(compactDuration(400)).toBe("1s");
    expect(compactDuration(59_000)).toBe("59s");
    expect(compactDuration(61_000)).toBe("1m 1s");
    expect(compactDuration(3_600_000)).toBe("1h");
    expect(compactDuration(7_260_000)).toBe("2h 1m");
  });

  it("names the running tool in the live activity label", () => {
    const summary = summaryWithFileEntries(
      summarizeToolMessages([
        toolMessage("a", {
          kind: "edited",
          path: "src/message-groups.tsx",
          rootPath: "/repo",
        }),
      ]),
      [],
    );

    expect(summary.running).toBe(0);

    const running = summarizeToolMessages([
      {
        id: "running",
        role: "agent",
        a2ui: {
          components: [
            {
              id: "tool-running",
              type: "tool-card",
              props: {
                title: "bash",
                description: "rg message-row",
                startedAt: 1000,
              },
            },
          ],
        },
      },
    ]);

    expect(activityLabel({ summary: running, progressCount: 0 })).toBe(
      "Running bash",
    );
  });

  it("labels the actual running tool when earlier tools are completed", () => {
    const summary = summarizeToolMessages([
      {
        id: "completed-read",
        role: "agent",
        a2ui: {
          components: [
            {
              id: "tool-read",
              type: "tool-card",
              props: {
                title: "read",
                toolName: "read",
                startedAt: 1000,
                endedAt: 1200,
              },
            },
          ],
        },
      },
      {
        id: "running-bash",
        role: "agent",
        a2ui: {
          components: [
            {
              id: "tool-bash",
              type: "tool-card",
              props: {
                title: "bash",
                toolName: "bash",
                startedAt: 1300,
              },
            },
          ],
        },
      },
    ]);

    expect(summary.names).toEqual(["read", "bash"]);
    expect(summary.runningNames).toEqual(["bash"]);
    expect(activityLabel({ summary, progressCount: 0 })).toBe("Running bash");
  });

  it("summarizes hidden live tool activity without exposing commands", () => {
    const activity = liveActivitySummary([
      {
        id: "running",
        role: "agent",
        a2ui: {
          components: [
            {
              id: "tool-running",
              type: "tool-card",
              props: {
                title: "bash",
                description: "rg message-row",
                startedAt: 1000,
              },
            },
          ],
        },
      },
    ]);

    expect(activity).toEqual({
      label: "Searching files",
      detail: "Looking for relevant matches",
    });
    expect(`${activity?.label} ${activity?.detail}`).not.toMatch(/bash|rg/);
  });

  it("classifies running directory inspection tools before generic search", () => {
    const activity = liveActivitySummary([
      {
        id: "running",
        role: "agent",
        a2ui: {
          components: [
            {
              id: "tool-running",
              type: "tool-card",
              props: {
                title: "bash",
                toolName: "bash",
                description: "find . -maxdepth 2 -type f | head -200",
                startedAt: 1000,
              },
            },
          ],
        },
      },
    ]);

    expect(activity).toEqual({
      label: "Reading directory contents",
      detail: "Inspecting files and folders",
    });
  });

  it("classifies running read tools from structured metadata", () => {
    const activity = liveActivitySummary([
      {
        id: "running",
        role: "agent",
        a2ui: {
          components: [
            {
              id: "tool-running",
              type: "tool-card",
              props: {
                title: "read",
                toolName: "read",
                filePath: "src/App.tsx",
                description: "src/App.tsx",
                startedAt: 1000,
              },
            },
          ],
        },
      },
    ]);

    expect(activity).toEqual({
      label: "Reading files",
      detail: "Inspecting file contents",
    });
  });

  it("combines repeated file changes without counting duplicate files", () => {
    const messages = [
      toolMessage("a", {
        kind: "edited",
        path: "src/message-groups.tsx",
        rootPath: "/repo",
        additions: 2,
        deletions: 1,
        preview:
          "diff --git a/src/message-groups.tsx b/src/message-groups.tsx\n@@\n-old\n+new",
      }),
      toolMessage("b", {
        kind: "edited",
        path: "src/message-groups.tsx",
        rootPath: "/repo",
        additions: 3,
        deletions: 4,
        preview:
          "diff --git a/src/message-groups.tsx b/src/message-groups.tsx\n@@\n-prev\n+next",
      }),
      toolMessage("c", {
        kind: "created",
        path: "src/turn-activity.tsx",
        rootPath: "/repo",
        additions: 10,
      }),
    ];

    const entries = collectFileChangeEntries(messages);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.change).toMatchObject({
      kind: "edited",
      path: "src/message-groups.tsx",
      additions: 5,
      deletions: 5,
    });
    expect(entries[0]?.change.preview).toContain("-old");
    expect(entries[0]?.change.preview).toContain("+next");

    const summary = summaryWithFileEntries(
      summarizeToolMessages(messages),
      entries,
    );
    expect(summary.fileChanges).toEqual({
      total: 2,
      created: 1,
      edited: 1,
      additions: 15,
      deletions: 5,
    });
    expect(fileChangeLabel(summary)).toBe("Changed 2 files");
  });

  it("classifies and bounds diff preview lines", () => {
    expect(lineTone("+added")).toBe("add");
    expect(lineTone("+++ b/file.ts")).toBe("meta");
    expect(lineTone("-removed")).toBe("del");
    expect(lineTone("--- a/file.ts")).toBe("meta");
    expect(lineTone("@@ -1 +1 @@")).toBe("hunk");
    expect(lineTone(" context")).toBe("ctx");

    const diff = Array.from(
      { length: 100 },
      (_, index) => `line ${index}`,
    ).join("\n");
    expect(previewLines(`${diff}\n`)).toHaveLength(80);
    expect(previewLines(`${diff}\n`).at(-1)).toBe("line 79");
  });
});
