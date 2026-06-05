import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildA2uiTools } from "./a2ui-tools";

interface FakeA2ui {
  getFrontendState: ReturnType<typeof vi.fn>;
  getLayout: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
  patchLayout: ReturnType<typeof vi.fn>;
  setLayout: ReturnType<typeof vi.fn>;
  canvas: {
    emit: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
}

let fakeA2ui: FakeA2ui;
let originalAethon: unknown;

beforeEach(() => {
  fakeA2ui = {
    getFrontendState: vi.fn(),
    getLayout: vi.fn(),
    setState: vi.fn(),
    patchLayout: vi.fn(),
    setLayout: vi.fn(),
    canvas: {
      emit: vi.fn(),
      append: vi.fn(),
      patch: vi.fn(),
      clear: vi.fn(),
    },
  };
  originalAethon = (globalThis as { aethon?: unknown }).aethon;
  (globalThis as { aethon?: FakeA2ui }).aethon = fakeA2ui;
});

afterEach(() => {
  (globalThis as { aethon?: unknown }).aethon = originalAethon;
});

function getTool(name: string) {
  const tool = buildA2uiTools().find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not in catalogue`);
  return tool;
}

describe("buildA2uiTools", () => {
  it("registers focused A2UI runtime tools", () => {
    expect(buildA2uiTools().map((t) => t.name).sort()).toEqual([
      "appendA2uiCanvas",
      "clearA2uiCanvas",
      "emitA2uiCanvas",
      "getA2uiLayout",
      "getA2uiState",
      "patchA2uiCanvas",
      "patchA2uiLayout",
      "setA2uiLayout",
      "setA2uiState",
    ]);
  });

  it("reads frontend state and layout as visible JSON", async () => {
    fakeA2ui.getFrontendState.mockReturnValue({ status: "ready" });
    fakeA2ui.getLayout.mockReturnValue({ components: [] });

    const state = await getTool("getA2uiState").execute("c1", {
      path: "/status",
    });
    const layout = await getTool("getA2uiLayout").execute("c2", {});

    expect(fakeA2ui.getFrontendState).toHaveBeenCalledWith("/status");
    expect(state.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({ status: "ready" }, null, 2),
    });
    expect(layout.details).toEqual({ components: [] });
  });

  it("forwards state and layout mutations", async () => {
    fakeA2ui.setState.mockResolvedValue({ ok: true });
    fakeA2ui.patchLayout.mockResolvedValue({ ok: true });
    fakeA2ui.setLayout.mockResolvedValue({ ok: true });

    await getTool("setA2uiState").execute("c1", {
      path: "/status",
      value: "working",
    });
    await getTool("patchA2uiLayout").execute("c2", {
      path: "/components/0/props/rows",
      value: "1fr",
    });
    await getTool("setA2uiLayout").execute("c3", {
      payload: { components: [] },
    });

    expect(fakeA2ui.setState).toHaveBeenCalledWith("/status", "working");
    expect(fakeA2ui.patchLayout).toHaveBeenCalledWith(
      "/components/0/props/rows",
      "1fr",
    );
    expect(fakeA2ui.setLayout).toHaveBeenCalledWith({ components: [] });
  });

  it("forwards canvas mutations", async () => {
    fakeA2ui.canvas.emit.mockResolvedValue({ ok: true });
    fakeA2ui.canvas.append.mockResolvedValue({ ok: true });
    fakeA2ui.canvas.patch.mockResolvedValue({ ok: true });
    fakeA2ui.canvas.clear.mockResolvedValue({ ok: true });
    const card = { type: "card", props: { title: "x" } };

    await getTool("emitA2uiCanvas").execute("c1", { components: card });
    await getTool("appendA2uiCanvas").execute("c2", { components: [card] });
    await getTool("patchA2uiCanvas").execute("c3", {
      path: "/components/0/props/title",
      value: "done",
    });
    await getTool("clearA2uiCanvas").execute("c4", {});

    expect(fakeA2ui.canvas.emit).toHaveBeenCalledWith(card);
    expect(fakeA2ui.canvas.append).toHaveBeenCalledWith([card]);
    expect(fakeA2ui.canvas.patch).toHaveBeenCalledWith(
      "/components/0/props/title",
      "done",
    );
    expect(fakeA2ui.canvas.clear).toHaveBeenCalledOnce();
  });

  it("throws on bridge failures so pi marks the tool result as an error", async () => {
    fakeA2ui.patchLayout.mockResolvedValue({ ok: false, error: "bad path" });
    await expect(
      getTool("patchA2uiLayout").execute("c1", {
        path: "/bad",
        value: 1,
      }),
    ).rejects.toThrow("bad path");
  });

  it("throws when the A2UI API is unavailable", () => {
    (globalThis as { aethon?: unknown }).aethon = undefined;
    expect(() => getTool("getA2uiLayout").execute("c1", {})).toThrow(
      /A2UI API unavailable/,
    );
  });
});
