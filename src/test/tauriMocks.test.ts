import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { clearTauriMocks, installTauriMocks } from "./tauriMocks";

describe("tauriMocks", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  it("captures invoke calls", async () => {
    harness.invoke.mockResolvedValueOnce("hello");
    const result = await invoke("greet", { name: "world" });
    expect(result).toBe("hello");
    expect(harness.invoke).toHaveBeenCalledWith("greet", { name: "world" });
  });

  it("delivers fired events to registered handlers", async () => {
    const received: string[] = [];
    await listen<string>("agent-response", (e) => {
      received.push(e.payload);
    });
    const fired = harness.fireEvent("agent-response", "first");
    expect(fired).toBe(1);
    expect(received).toEqual(["first"]);
  });

  it("supports multiple handlers per event", async () => {
    const a: number[] = [];
    const b: number[] = [];
    await listen<number>("tick", (e) => a.push(e.payload));
    await listen<number>("tick", (e) => b.push(e.payload));
    harness.fireEvent("tick", 42);
    expect(a).toEqual([42]);
    expect(b).toEqual([42]);
  });

  it("unlisten removes the handler", async () => {
    const got: string[] = [];
    const off = await listen<string>("ping", (e) => got.push(e.payload));
    off();
    expect(harness.fireEvent("ping", "hi")).toBe(0);
    expect(got).toEqual([]);
  });
});
