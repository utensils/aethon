import { describe, expect, it } from "vitest";
import type { Agent } from "@mariozechner/pi-agent-core";
import {
  wrapWithSourceGuard,
  bashEscapesRoot,
  isInsideRoot,
} from "./source-guard";

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

function bashCtx(command: string) {
  return {
    toolCall: { name: "bash" },
    args: { command },
    assistantMessage: {},
    context: {},
  } as Parameters<NonNullable<Agent["beforeToolCall"]>>[0];
}

const ROOT = "/Users/dev/Projects/aethon";

describe("wrapWithSourceGuard", () => {
  it("is a no-op when projectRoot is undefined (release mode)", () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, undefined);
    expect(agent.beforeToolCall).toBeUndefined();
  });

  it("blocks write to src/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall(ctx("write", `${ROOT}/src/App.tsx`), undefined);
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("source tree");
  });

  it("blocks write to src-tauri/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall(ctx("write", `${ROOT}/src-tauri/src/lib.rs`), undefined);
    expect(r?.block).toBe(true);
  });

  it("blocks write to agent/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall(ctx("write", `${ROOT}/agent/main.ts`), undefined);
    expect(r?.block).toBe(true);
  });

  it("blocks edit to src/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall(ctx("edit", `${ROOT}/src/hooks/useTabs.ts`), undefined);
    expect(r?.block).toBe(true);
  });

  it("allows write to ~/.aethon/extensions/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall(ctx("write", "/Users/dev/.aethon/extensions/clock.ts"), undefined);
    expect(r?.block).toBeFalsy();
  });

  it("allows write to project .aethon/extensions/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall(ctx("write", `${ROOT}/.aethon/extensions/foo.ts`), undefined);
    expect(r?.block).toBeFalsy();
  });

  it("allows write to docs/", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall(ctx("write", `${ROOT}/docs/aethon-agent/api.md`), undefined);
    expect(r?.block).toBeFalsy();
  });

  it("allows read to src/ (reading source is fine)", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall(ctx("read", `${ROOT}/src/App.tsx`), undefined);
    expect(r?.block).toBeFalsy();
  });

  it("allows bash (too complex to parse reliably)", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall(ctx("bash", "echo hello > src/foo.ts"), undefined);
    expect(r?.block).toBeFalsy();
  });

  it("blocks relative paths that resolve into source tree", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall(ctx("write", `${ROOT}/docs/../src/App.tsx`), undefined);
    expect(r?.block).toBe(true);
  });

  it("delegates to the original beforeToolCall for allowed calls", async () => {
    let originalCalled = false;
    const agent = makeAgent(() => {
      originalCalled = true;
      return Promise.resolve(undefined);
    });
    wrapWithSourceGuard(agent, ROOT);
    await agent.beforeToolCall(ctx("write", "/tmp/test.ts"), undefined);
    expect(originalCalled).toBe(true);
  });

  it("runs the original beforeToolCall after passing the guard", async () => {
    const agent = makeAgent(() =>
      Promise.resolve({
        block: true,
        reason: "extension runner blocked",
      }),
    );
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall(ctx("write", "/tmp/test.ts"), undefined);
    expect(r?.block).toBe(true);
    expect(r?.reason).toBe("extension runner blocked");
  });

  it("skips guard when args has no path", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT);
    const r = await agent.beforeToolCall(ctx("write"), undefined);
    expect(r?.block).toBeFalsy();
  });
});

describe("wrapWithSourceGuard hard project-root enforcement", () => {
  const TAB = "/Users/dev/Projects/myapp";
  const hard = (on = true) => ({ tabRoot: TAB, hardEnforce: () => on });

  it("is a no-op when neither source root nor a hard guard is supplied", () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, undefined, { hardEnforce: () => true });
    expect(agent.beforeToolCall).toBeUndefined();
  });

  it("does not enforce while hardEnforce() is false", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, undefined, hard(false));
    const r = await agent.beforeToolCall(ctx("write", "/etc/passwd"), undefined);
    expect(r?.block).toBeFalsy();
  });

  it("blocks mutating tools while plan mode is on", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, undefined, {
      tabRoot: TAB,
      planMode: () => true,
    });

    for (const tool of [
      "write",
      "edit",
      "bash",
      "task",
      "task_batch",
      "startTask",
      "writeShell",
    ]) {
      const r = await agent.beforeToolCall(ctx(tool, "src/file.ts"), undefined);
      expect(r?.block).toBe(true);
      expect(r?.reason).toContain("Plan mode is on");
    }
  });

  it("allows read-only tools while plan mode is on", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, undefined, {
      tabRoot: TAB,
      planMode: () => true,
    });
    const r = await agent.beforeToolCall(ctx("read", "src/file.ts"), undefined);
    expect(r?.block).toBeFalsy();
  });

  it("reads hardEnforce() live so a runtime toggle takes effect", async () => {
    let on = false;
    const agent = makeAgent();
    wrapWithSourceGuard(agent, undefined, {
      tabRoot: TAB,
      hardEnforce: () => on,
    });
    expect(
      (await agent.beforeToolCall(ctx("write", "/etc/x"), undefined))?.block,
    ).toBeFalsy();
    on = true;
    expect(
      (await agent.beforeToolCall(ctx("write", "/etc/x"), undefined))?.block,
    ).toBe(true);
  });

  it("blocks write/edit outside the tab root", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, undefined, hard());
    const r = await agent.beforeToolCall(ctx("write", "/etc/passwd"), undefined);
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("outside the active project root");
  });

  it("allows write/edit inside the tab root (absolute + relative)", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, undefined, hard());
    expect(
      (await agent.beforeToolCall(ctx("edit", `${TAB}/src/x.ts`), undefined))
        ?.block,
    ).toBeFalsy();
    expect(
      (await agent.beforeToolCall(ctx("write", "notes/todo.md"), undefined))
        ?.block,
    ).toBeFalsy();
  });

  it("blocks a relative write that climbs out via ..", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, undefined, hard());
    const r = await agent.beforeToolCall(
      ctx("write", "../sibling/x.ts"),
      undefined,
    );
    expect(r?.block).toBe(true);
  });

  it("blocks bash redirecting / cd-ing outside the root", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, undefined, hard());
    expect(
      (
        await agent.beforeToolCall(
          bashCtx("echo pwned > /etc/cron.d/x"),
          undefined,
        )
      )?.block,
    ).toBe(true);
    expect(
      (await agent.beforeToolCall(bashCtx("cd /tmp && rm -rf foo"), undefined))
        ?.block,
    ).toBe(true);
  });

  it("allows bash writing inside the root or not writing at all", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, undefined, hard());
    expect(
      (await agent.beforeToolCall(bashCtx("echo hi > out.txt"), undefined))
        ?.block,
    ).toBeFalsy();
    expect(
      (await agent.beforeToolCall(bashCtx("npm test"), undefined))?.block,
    ).toBeFalsy();
    expect(
      (await agent.beforeToolCall(bashCtx("cat ../README.md"), undefined))
        ?.block,
    ).toBeFalsy(); // reads aren't write targets
  });

  it("still enforces the Aethon source guard alongside hard enforcement", async () => {
    const agent = makeAgent();
    wrapWithSourceGuard(agent, ROOT, hard());
    // Inside the tab root but inside Aethon's source — source guard wins.
    const r = await agent.beforeToolCall(
      ctx("write", `${ROOT}/src/App.tsx`),
      undefined,
    );
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("source tree");
  });
});

describe("bashEscapesRoot / isInsideRoot", () => {
  const ROOT2 = "/work/repo";

  it("isInsideRoot handles root, descendants, and siblings", () => {
    expect(isInsideRoot("/work/repo", ROOT2)).toBe(true);
    expect(isInsideRoot("/work/repo/src/a.ts", ROOT2)).toBe(true);
    expect(isInsideRoot("/work/repo-evil/x", ROOT2)).toBe(false);
    expect(isInsideRoot("/etc/passwd", ROOT2)).toBe(false);
  });

  it("flags redirections, tee, and cd that escape; passes in-root writes", () => {
    expect(bashEscapesRoot("echo x > /etc/y", ROOT2)).toBe("/etc/y");
    expect(bashEscapesRoot("echo x >> ../out", ROOT2)).toBe("/work/out");
    expect(bashEscapesRoot("foo | tee /tmp/z", ROOT2)).toBe("/tmp/z");
    expect(bashEscapesRoot("cd /usr/local", ROOT2)).toBe("/usr/local");
    expect(bashEscapesRoot("echo x > build/out.txt", ROOT2)).toBeUndefined();
    expect(bashEscapesRoot("grep -r foo .", ROOT2)).toBeUndefined();
  });
});
