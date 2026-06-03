import { describe, expect, it } from "vitest";
import {
  handleSubagentProgress,
  type SubagentProgress,
} from "./subagentProgress";
import { buildHandlerFixture } from "./testFixtures";
import type { BridgeMessageContext } from "./types";

function fire(ctx: BridgeMessageContext, info: Record<string, unknown>) {
  handleSubagentProgress(
    { type: "subagent_progress", tabId: "t1", parentCallId: "c1", ...info },
    ctx,
  );
}

function progress(ctx: BridgeMessageContext): SubagentProgress | undefined {
  const map = ctx.stateRef.current.subagentProgress as
    | Record<string, SubagentProgress>
    | undefined;
  return map?.c1;
}

describe("handleSubagentProgress", () => {
  it("accumulates tool steps, streamed text, and the done flag", () => {
    const { ctx } = buildHandlerFixture();
    fire(ctx, {
      phase: "start",
      subagent: "reviewer",
      model: "ollama/llama3.3",
    });
    fire(ctx, {
      phase: "tool_start",
      toolName: "read",
      toolSummary: "src/foo.ts",
    });
    fire(ctx, { phase: "text", delta: "Found " });
    fire(ctx, { phase: "text", delta: "a bug." });
    fire(ctx, { phase: "done" });

    const p = progress(ctx);
    expect(p?.subagent).toBe("reviewer");
    expect(p?.model).toBe("ollama/llama3.3");
    expect(p?.steps).toEqual([{ kind: "tool", label: "read src/foo.ts" }]);
    expect(p?.text).toBe("Found a bug.");
    expect(p?.done).toBe(true);
  });

  it("records errors as error steps", () => {
    const { ctx } = buildHandlerFixture();
    fire(ctx, { phase: "error", error: "model overloaded" });
    expect(progress(ctx)?.steps).toEqual([
      { kind: "error", label: "model overloaded" },
    ]);
  });

  it("ignores events without a parentCallId", () => {
    const { ctx } = buildHandlerFixture();
    handleSubagentProgress(
      { type: "subagent_progress", phase: "text", delta: "x" },
      ctx,
    );
    expect(ctx.stateRef.current.subagentProgress).toBeUndefined();
  });
});
