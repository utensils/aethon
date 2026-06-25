// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeToolMessages } from "../../utils/toolCardGrouping";
import { ToolFileChangesCard } from "./tool-file-changes";
import type { ToolFileChangeEntry } from "./tool-activity-summary";

const baseSummary = summarizeToolMessages([]);

afterEach(cleanup);

describe("ToolFileChangesCard", () => {
  it("announces concrete line-change counts", () => {
    render(
      <ToolFileChangesCard
        entries={[
          {
            change: {
              kind: "edited",
              path: "src/file.ts",
              additions: 3,
              deletions: 2,
            },
          },
        ]}
        summary={baseSummary}
      />,
    );

    expect(screen.getByLabelText("Line changes: +3 -2")).toBeTruthy();
  });

  it("uses stable distinct row keys for identical paths under different roots", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const entries: ToolFileChangeEntry[] = [
      {
        change: {
          kind: "edited",
          path: "src/file.ts",
          rootPath: "/worktree-a",
          additions: 1,
        },
      },
      {
        change: {
          kind: "edited",
          path: "src/file.ts",
          rootPath: "/worktree-b",
          deletions: 1,
        },
      },
    ];

    render(<ToolFileChangesCard entries={entries} summary={baseSummary} />);

    expect(
      errorSpy.mock.calls.some((args) =>
        args.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("Encountered two children with the same key"),
        ),
      ),
    ).toBe(false);
    errorSpy.mockRestore();
  });
});
