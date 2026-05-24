import { describe, expect, it } from "vitest";
import type { Agent } from "@mariozechner/pi-agent-core";
import { wrapWithSourceGuard } from "./source-guard";

function makeAgent(existing?: Agent["beforeToolCall"]): Agent {
  return { beforeToolCall: existing } as unknown as Agent;
}

function ctx(tool: string, path?: string) {
  return {
    toolCall: { name: tool },
    args: path !== undefined ? { path } : {},
    assistantMessage: {},
    context: {},
  } as Parameters<NonNullable<Agent["beforeToolCall"]>>[0];
}

const ROOT = "/Users/dev/Projects/aethon";

describe("wrapWithSourceGuard", () => {
  it("is a no-op when projectRoot is undefined (release mode)", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, undefined);
    expect(agent.beforeToolCall).toBeUndefined();
  });

  it("blocks write to src/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall!(ctx("write", `${ROOT}/src/App.tsx`), undefined);
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("source tree");
  });

  it("blocks write to src-tauri/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall!(ctx("write", `${ROOT}/src-tauri/src/lib.rs`), undefined);
    expect(r?.block).toBe(true);
  });

  it("blocks write to agent/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall!(ctx("write", `${ROOT}/agent/main.ts`), undefined);
    expect(r?.block).toBe(true);
  });

  it("blocks edit to src/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall!(ctx("edit", `${ROOT}/src/hooks/useTabs.ts`), undefined);
    expect(r?.block).toBe(true);
  });

  it("allows write to ~/.aethon/extensions/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall!(ctx("write", "/Users/dev/.aethon/extensions/clock.ts"), undefined);
    expect(r?.block).toBeFalsy();
  });

  it("allows write to project .aethon/extensions/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall!(ctx("write", `${ROOT}/.aethon/extensions/foo.ts`), undefined);
    expect(r?.block).toBeFalsy();
  });

  it("allows write to docs/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall!(ctx("write", `${ROOT}/docs/aethon-agent/api.md`), undefined);
    expect(r?.block).toBeFalsy();
  });

  it("allows read to src/ (reading source is fine)", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall!(ctx("read", `${ROOT}/src/App.tsx`), undefined);
    expect(r?.block).toBeFalsy();
  });

  it("allows bash (too complex to parse reliably)", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall!(ctx("bash", "echo hello > src/foo.ts"), undefined);
    expect(r?.block).toBeFalsy();
  });

  it("blocks relative paths that resolve into source tree", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall!(ctx("write", `${ROOT}/docs/../src/App.tsx`), undefined);
    expect(r?.block).toBe(true);
  });

  it("delegates to the original beforeToolCall for allowed calls", async () => {
    let originalCalled = false;
    const agent = makeAgent(async () => {
      originalCalled = true;
      return undefined;
    });
    wrapWithSourceGuard(agent, ROOT);
    await agent.beforeToolCall!(ctx("write", "/tmp/test.ts"), undefined);
    expect(originalCalled).toBe(true);
  });

  it("runs the original beforeToolCall after passing the guard", async () => {
    const agent = makeAgent(async () => ({
      block: true,
      reason: "extension runner blocked",
    }));
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall!(ctx("write", "/tmp/test.ts"), undefined);
    expect(r?.block).toBe(true);
    expect(r?.reason).toBe("extension runner blocked");
  });

  it("skips guard when args has no path", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall!(ctx("write"), undefined);
    expect(r?.block).toBeFalsy();
  });
});
