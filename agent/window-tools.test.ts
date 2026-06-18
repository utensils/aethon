import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWindowTools } from "./window-tools";

function installWindowsApi(overrides: Record<string, unknown> = {}) {
  const windows = {
    openCanvas: vi.fn(() => Promise.resolve({ ok: true, data: { id: "w" } })),
    list: vi.fn(() => Promise.resolve({ ok: true, data: { windows: [] } })),
    focus: vi.fn(() => Promise.resolve({ ok: true })),
    close: vi.fn(() => Promise.resolve({ ok: true })),
    setTitle: vi.fn(() => Promise.resolve({ ok: true })),
    emitCanvas: vi.fn(() => Promise.resolve({ ok: true })),
    appendCanvas: vi.fn(() => Promise.resolve({ ok: true })),
    patchCanvas: vi.fn(() => Promise.resolve({ ok: true })),
    clearCanvas: vi.fn(() => Promise.resolve({ ok: true })),
    setState: vi.fn(() => Promise.resolve({ ok: true })),
    ...overrides,
  };
  (globalThis as { aethon?: unknown }).aethon = { windows };
  return windows;
}

async function executeTool(name: string, params: Record<string, unknown>) {
  const tool = buildWindowTools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return await (
    tool as unknown as {
      execute(
        callId: string,
        params: Record<string, unknown>,
      ): Promise<unknown>;
    }
  ).execute("call-1", params);
}

describe("buildWindowTools", () => {
  afterEach(() => {
    delete (globalThis as { aethon?: unknown }).aethon;
  });

  it("exposes the native canvas window tool names", () => {
    const names = buildWindowTools().map((tool) => tool.name);
    expect(names).toEqual([
      "openA2uiCanvasWindow",
      "listA2uiCanvasWindows",
      "focusA2uiCanvasWindow",
      "closeA2uiCanvasWindow",
      "setA2uiCanvasWindowTitle",
      "emitA2uiWindowCanvas",
      "appendA2uiWindowCanvas",
      "patchA2uiWindowCanvas",
      "clearA2uiWindowCanvas",
      "setA2uiWindowState",
    ]);
  });

  it("openA2uiCanvasWindow calls aethon.windows.openCanvas", async () => {
    const windows = installWindowsApi();
    await executeTool("openA2uiCanvasWindow", {
      id: "Workpad",
      title: "Workpad",
      components: [{ id: "root", type: "card" }],
    });
    expect(windows.openCanvas).toHaveBeenCalledWith({
      id: "Workpad",
      title: "Workpad",
      components: [{ id: "root", type: "card" }],
    });
  });

  it("patch and state tools forward id/path/value", async () => {
    const windows = installWindowsApi();
    await executeTool("patchA2uiWindowCanvas", {
      id: "Workpad",
      path: "/components/0/props/title",
      value: "Two",
    });
    await executeTool("setA2uiWindowState", {
      id: "Workpad",
      path: "/draft",
      value: "hello",
    });
    expect(windows.patchCanvas).toHaveBeenCalledWith(
      "Workpad",
      "/components/0/props/title",
      "Two",
    );
    expect(windows.setState).toHaveBeenCalledWith("Workpad", "/draft", "hello");
  });

  it("throws when the runtime API returns ok false", async () => {
    installWindowsApi({
      focus: vi.fn(() => Promise.resolve({ ok: false, error: "nope" })),
    });
    await expect(
      executeTool("focusA2uiCanvasWindow", { id: "Missing" }),
    ).rejects.toThrow("nope");
  });
});
