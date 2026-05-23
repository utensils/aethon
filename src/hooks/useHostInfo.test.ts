// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// Tauri mocks: invoke returns a local host; listen exposes a hook so
// tests can fire host-discovered / host-removed payloads.
const eventListeners = new Map<string, Array<(event: { payload: unknown }) => void>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) =>
    cmd === "host_info"
      ? { id: "local:abc", hostname: "halcyon.local", displayName: "halcyon", fingerprint: "fp" }
      : null,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async <T,>(event: string, cb: (e: { payload: T }) => void) => {
    const list = eventListeners.get(event) ?? [];
    list.push(cb as (event: { payload: unknown }) => void);
    eventListeners.set(event, list);
    return () => {
      const next = (eventListeners.get(event) ?? []).filter((fn) => fn !== cb);
      eventListeners.set(event, next);
    };
  },
}));

vi.mock("../persist", () => ({
  readState: async () => null,
  writeState: async () => undefined,
}));

function fireEvent(name: string, payload: unknown): void {
  for (const cb of eventListeners.get(name) ?? []) cb({ payload });
}

describe("useHostInfo", () => {
  it("resolves the local host and defaults activeHostId to it", async () => {
    const { useHostInfo } = await import("./useHostInfo");
    const { _resetLocalHostCacheForTests } = await import("../hosts");
    _resetLocalHostCacheForTests();
    eventListeners.clear();
    const { result } = renderHook(() => useHostInfo());
    await waitFor(() => {
      expect(result.current.localHostId).toBe("local:abc");
    });
    expect(result.current.activeHostId).toBe("local:abc");
    expect(result.current.hosts[0]?.isLocal).toBe(true);
  });

  it("merges remote hosts and removes them on host-removed", async () => {
    const { useHostInfo } = await import("./useHostInfo");
    const { _resetLocalHostCacheForTests } = await import("../hosts");
    _resetLocalHostCacheForTests();
    eventListeners.clear();
    const { result } = renderHook(() => useHostInfo());
    await waitFor(() => {
      expect(result.current.localHostId).toBe("local:abc");
    });
    act(() => {
      fireEvent("host-discovered", {
        id: "remote:bender",
        hostname: "bender.local",
        displayName: "bender",
        port: 4242,
        fingerprintPrefix: "ben",
        lastSeen: 1,
      });
    });
    await waitFor(() => {
      expect(result.current.hosts.find((h) => h.id === "remote:bender")).toBeTruthy();
    });
    act(() => {
      fireEvent("host-removed", { id: "remote:bender" });
    });
    await waitFor(() => {
      expect(result.current.hosts.find((h) => h.id === "remote:bender")).toBeUndefined();
    });
  });
});
