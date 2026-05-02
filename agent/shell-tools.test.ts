// Pi-tool wrapper tests for `buildShellTools()`. Each tool is a thin
// shim that calls the `globalThis.aethon.shells.*` API and adapts the
// result into the AgentToolResult shape the model sees. The bridge's
// security boundary (share-mode gates, privacy floor, read-write
// consent) lives in shell.rs / agent/main.ts — tested separately. What
// these tests verify:
//   1. The right shells.* method is called with the right args (read /
//      write tool dispatch).
//   2. ok=false from the bridge surfaces as an `Error: …` text content
//      and an errorMessage so the model sees the failure.
//   3. ok=true with no data returns a sensible empty content (not crash).
//   4. The privacy-floor + share-mode boundary errors flow through
//      verbatim — we don't accidentally swallow an "share mode private"
//      reason and report "unknown" instead.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildShellTools } from "./shell-tools";

interface FakeShells {
  list: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

let fakeShells: FakeShells;
let originalAethon: unknown;

beforeEach(() => {
  fakeShells = {
    list: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
  };
  originalAethon = (globalThis as { aethon?: unknown }).aethon;
  (globalThis as { aethon?: { shells: FakeShells } }).aethon = {
    shells: fakeShells,
  };
});

afterEach(() => {
  (globalThis as { aethon?: unknown }).aethon = originalAethon;
});

function getTool(name: string) {
  const tools = buildShellTools();
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`tool ${name} not in catalogue`);
  return t;
}

describe("buildShellTools()", () => {
  it("registers exactly listShells, readShell, writeShell", () => {
    const tools = buildShellTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "listShells",
      "readShell",
      "writeShell",
    ]);
  });
});

describe("listShells tool", () => {
  it("returns the bridge's data verbatim on ok", async () => {
    const data = [
      { tabId: "abc", cwd: "/", command: "zsh", shareMode: "read" },
    ];
    fakeShells.list.mockResolvedValue({ ok: true, data });

    const tool = getTool("listShells");
    const result = await tool.execute("call-1", {});

    expect(fakeShells.list).toHaveBeenCalledOnce();
    expect(result.errorMessage).toBeUndefined();
    expect(result.details).toEqual(data);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify(data, null, 2),
    });
  });

  it("surfaces ok=false via errorMessage and an Error: prefix", async () => {
    fakeShells.list.mockResolvedValue({ ok: false, error: "frontend_not_ready" });

    const tool = getTool("listShells");
    const result = await tool.execute("call-1", {});

    expect(result.errorMessage).toBe("frontend_not_ready");
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Error: frontend_not_ready",
    });
  });

  it("returns an empty list when bridge omits data", async () => {
    fakeShells.list.mockResolvedValue({ ok: true });

    const tool = getTool("listShells");
    const result = await tool.execute("call-1", {});

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "[]",
    });
  });

  it("falls back to a generic error when api unavailable", async () => {
    (globalThis as { aethon?: unknown }).aethon = undefined;

    const tool = getTool("listShells");
    const result = await tool.execute("call-1", {});

    expect(result.errorMessage).toMatch(/aethon\.shells API unavailable/);
  });
});

describe("readShell tool", () => {
  it("forwards optional cursor/maxBytes only when defined", async () => {
    fakeShells.read.mockResolvedValue({
      ok: true,
      data: { content: "$ ls\nfoo\n", totalAppended: 9 },
    });

    const tool = getTool("readShell");
    await tool.execute("call-1", { tabId: "tab-1" });
    expect(fakeShells.read).toHaveBeenCalledWith({ tabId: "tab-1" });

    await tool.execute("call-2", { tabId: "tab-1", sinceTotal: 9 });
    expect(fakeShells.read).toHaveBeenLastCalledWith({
      tabId: "tab-1",
      sinceTotal: 9,
    });

    await tool.execute("call-3", {
      tabId: "tab-1",
      sinceTotal: 9,
      maxBytes: 4096,
    });
    expect(fakeShells.read).toHaveBeenLastCalledWith({
      tabId: "tab-1",
      sinceTotal: 9,
      maxBytes: 4096,
    });
  });

  it("returns the content string as the visible text", async () => {
    fakeShells.read.mockResolvedValue({
      ok: true,
      data: {
        content: "boot banner\n$ ",
        totalAppended: 14,
        shareFloor: 0,
        shareMode: "read",
      },
    });

    const tool = getTool("readShell");
    const result = await tool.execute("call-1", { tabId: "tab-1" });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "boot banner\n$ ",
    });
    expect(result.details).toMatchObject({
      shareFloor: 0,
      totalAppended: 14,
      shareMode: "read",
    });
  });

  it("propagates the privacy-floor refusal verbatim", async () => {
    // shell.rs returns this error string when read is attempted on a
    // private tab. The tool must not swallow it as 'unknown'.
    fakeShells.read.mockResolvedValue({
      ok: false,
      error: "share mode is private",
    });

    const tool = getTool("readShell");
    const result = await tool.execute("call-1", { tabId: "tab-1" });

    expect(result.errorMessage).toBe("share mode is private");
  });

  it("treats missing data as an empty content payload", async () => {
    fakeShells.read.mockResolvedValue({ ok: true });

    const tool = getTool("readShell");
    const result = await tool.execute("call-1", { tabId: "tab-1" });

    expect(result.content[0]).toMatchObject({ type: "text", text: "" });
  });
});

describe("writeShell tool", () => {
  it("forwards tabId + text without normalisation", async () => {
    fakeShells.write.mockResolvedValue({ ok: true });

    const tool = getTool("writeShell");
    await tool.execute("call-1", { tabId: "tab-1", text: "echo hi\n" });

    expect(fakeShells.write).toHaveBeenCalledWith({
      tabId: "tab-1",
      text: "echo hi\n",
    });
  });

  it("returns 'ok' as the visible text on success", async () => {
    fakeShells.write.mockResolvedValue({ ok: true });

    const tool = getTool("writeShell");
    const result = await tool.execute("call-1", {
      tabId: "tab-1",
      text: "ls\n",
    });

    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
  });

  it("propagates a denied-by-user refusal", async () => {
    // Bridge returns this when the user clicks Deny on the consent
    // prompt (or it auto-expires).
    fakeShells.write.mockResolvedValue({
      ok: false,
      error: "user denied write",
    });

    const tool = getTool("writeShell");
    const result = await tool.execute("call-1", {
      tabId: "tab-1",
      text: "rm -rf /\n",
    });

    expect(result.errorMessage).toBe("user denied write");
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Error: user denied write",
    });
  });

  it("propagates a private-tab refusal", async () => {
    fakeShells.write.mockResolvedValue({
      ok: false,
      error: "share mode does not allow writes",
    });

    const tool = getTool("writeShell");
    const result = await tool.execute("call-1", {
      tabId: "tab-1",
      text: "x",
    });

    expect(result.errorMessage).toBe("share mode does not allow writes");
  });
});
