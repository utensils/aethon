import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RustBridgeAdapter } from "./rustBridgeAdapter";

// In-memory stand-in for the mobile shell's `gateway-frame` event bus.
// The real bug lived here: each open() registered one more listener on
// this bus but only the latest unlisten was kept, so after N reconnects
// every frame was delivered N times (assistant text duplication, #462).
const bus = vi.hoisted(() => ({
  listeners: new Set<(e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-real/event", () => ({
  listen: (_event: string, handler: (e: { payload: unknown }) => void) => {
    bus.listeners.add(handler);
    return Promise.resolve(() => bus.listeners.delete(handler));
  },
}));

function emitFrame(frame: { kind: string; text?: string }): void {
  for (const listener of [...bus.listeners]) listener({ payload: frame });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RustBridgeAdapter", () => {
  const invoke = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    bus.listeners.clear();
    invoke.mockClear();
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke,
    };
  });

  afterEach(() => {
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("reopening replaces the gateway-frame listener instead of stacking", async () => {
    const adapter = new RustBridgeAdapter("fp");
    const received: string[] = [];
    adapter.onMessage((text) => received.push(text));

    adapter.open("wss://host/ws");
    await flush();
    expect(bus.listeners.size).toBe(1);

    // The transport reuses one adapter instance across reconnects.
    adapter.open("wss://host/ws");
    await flush();
    expect(bus.listeners.size).toBe(1);

    emitFrame({ kind: "message", text: "hello" });
    expect(received).toEqual(["hello"]);
  });

  it("close() during a pending open drops the late listener registration", async () => {
    const adapter = new RustBridgeAdapter("fp");
    adapter.open("wss://host/ws");
    adapter.close(); // races the async listen() registration
    await flush();

    expect(bus.listeners.size).toBe(0);
    // The superseded open must not proceed to connect either.
    expect(invoke).not.toHaveBeenCalledWith("gateway_connect", {
      url: "wss://host/ws",
      fingerprint: "fp",
    });
  });

  it("frames stop after close() even if an unlisten is still in flight", async () => {
    const adapter = new RustBridgeAdapter("fp");
    const received: string[] = [];
    adapter.onMessage((text) => received.push(text));

    adapter.open("wss://host/ws");
    await flush();
    adapter.close();
    emitFrame({ kind: "message", text: "stale" });

    expect(received).toEqual([]);
  });
});
