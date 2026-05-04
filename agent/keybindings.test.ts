import { describe, expect, it } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
} from "./state";
import {
  canonicalizeCombo,
  registerKeybinding,
  unregisterKeybinding,
} from "./keybindings";

const baseOpts: AethonAgentStateOptions = {
  userDir: "/tmp/aethon-test",
  stateFile: "/tmp/aethon-test/state.json",
  sessionsDir: "/tmp/aethon-test/sessions",
  docsDir: undefined,
  projectRoot: undefined,
  releaseMode: false,
  bootLayoutFile: undefined,
  layoutSlotsFile: undefined,
  statePayloadWarnBytes: 64 * 1024,
  statePayloadHardBytes: 512 * 1024,
  statePayloadWarnKb: 64,
  statePayloadHardKb: 512,
};

function makeFixture() {
  const state = new AethonAgentState(baseOpts);
  const sent: Record<string, unknown>[] = [];
  let stateFileWrites = 0;
  return {
    state,
    sent,
    deps: {
      send: (m: Record<string, unknown>) => sent.push(m),
      scheduleStateFileWrite: () => {
        stateFileWrites += 1;
      },
    },
    stateFileWriteCount: () => stateFileWrites,
  };
}

describe("canonicalizeCombo", () => {
  it("orders modifiers meta → ctrl → alt → shift then key", () => {
    expect(canonicalizeCombo("Shift+Alt+Ctrl+Cmd+P")).toBe(
      "meta+ctrl+alt+shift+p",
    );
    expect(canonicalizeCombo("Cmd+P")).toBe("meta+p");
  });

  it("aliases cmd → meta, command → meta, control → ctrl, option → alt", () => {
    expect(canonicalizeCombo("Command+P")).toBe("meta+p");
    expect(canonicalizeCombo("Control+P")).toBe("ctrl+p");
    expect(canonicalizeCombo("Option+P")).toBe("alt+p");
  });

  it("normalizes case + whitespace", () => {
    expect(canonicalizeCombo("  CMD  +  P  ")).toBe("meta+p");
  });

  it("collapses duplicate modifiers", () => {
    expect(canonicalizeCombo("Cmd+Cmd+P")).toBe("meta+p");
  });

  it("returns just modifiers when no key supplied", () => {
    expect(canonicalizeCombo("Cmd+Shift")).toBe("meta+shift");
  });

  it("empty input → empty string", () => {
    expect(canonicalizeCombo("")).toBe("");
  });
});

describe("registerKeybinding", () => {
  it("rejects non-object input", async () => {
    const f = makeFixture();
    await expect(registerKeybinding(f.state, f.deps, null)).resolves.toEqual({
      ok: false,
      error: "binding requires { combo }",
    });
  });

  it("rejects empty / whitespace combos with a notice + error", async () => {
    const f = makeFixture();
    const result = await registerKeybinding(f.state, f.deps, { combo: "  " });
    expect(result.ok).toBe(false);
    expect(f.sent[0]).toMatchObject({ type: "notice" });
  });

  it("registers a combo, defaults action, emits extension_keybindings", async () => {
    const f = makeFixture();
    await registerKeybinding(f.state, f.deps, { combo: "Cmd+P" });
    expect(f.state.extensionKeybindings.get("meta+p")).toEqual({
      combo: "meta+p",
      action: "meta+p",
    });
    expect(f.sent[0]).toMatchObject({
      type: "extension_keybindings",
      bindings: [{ combo: "meta+p", action: "meta+p" }],
    });
    expect(f.stateFileWriteCount()).toBe(1);
  });

  it("preserves explicit action + description", async () => {
    const f = makeFixture();
    await registerKeybinding(f.state, f.deps, {
      combo: "Cmd+J",
      action: "open-jump",
      description: "Open jump-to-file palette",
    });
    expect(f.state.extensionKeybindings.get("meta+j")).toEqual({
      combo: "meta+j",
      action: "open-jump",
      description: "Open jump-to-file palette",
    });
  });

  it("re-registering the same combo replaces the prior binding", async () => {
    const f = makeFixture();
    await registerKeybinding(f.state, f.deps, {
      combo: "Cmd+P",
      action: "first",
    });
    await registerKeybinding(f.state, f.deps, {
      combo: "Cmd+P",
      action: "second",
    });
    expect(f.state.extensionKeybindings.size).toBe(1);
    expect(f.state.extensionKeybindings.get("meta+p")?.action).toBe("second");
  });
});

describe("unregisterKeybinding", () => {
  it("rejects bad input", async () => {
    const f = makeFixture();
    await expect(
      unregisterKeybinding(f.state, f.deps, null),
    ).resolves.toEqual({ ok: false, error: "combo required" });
    await expect(
      unregisterKeybinding(f.state, f.deps, "  "),
    ).resolves.toEqual({ ok: false, error: "combo required" });
  });

  it("returns no such combo on miss", async () => {
    const f = makeFixture();
    await expect(
      unregisterKeybinding(f.state, f.deps, "Cmd+X"),
    ).resolves.toEqual({ ok: false, error: "no such combo" });
  });

  it("removes the binding and emits an updated list", async () => {
    const f = makeFixture();
    await registerKeybinding(f.state, f.deps, { combo: "Cmd+P" });
    await registerKeybinding(f.state, f.deps, { combo: "Cmd+J" });
    f.sent.length = 0;
    const result = await unregisterKeybinding(f.state, f.deps, "Cmd+P");
    expect(result.ok).toBe(true);
    expect(f.state.extensionKeybindings.has("meta+p")).toBe(false);
    expect(f.sent[0]).toMatchObject({
      type: "extension_keybindings",
      bindings: [{ combo: "meta+j" }],
    });
  });
});
