// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// Tauri mocks: invoke returns a local host; listen exposes a hook so
// tests can fire host-discovered / host-removed payloads.
const eventListeners = new Map<string, Array<(event: { payload: unknown }) => void>>();

const remoteDevices: unknown[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) =>
    Promise.resolve(
      cmd === "host_info"
        ? {
            id: "local:abc",
            hostname: "halcyon.local",
            displayName: "halcyon",
            fingerprint: "fp",
          }
        : cmd === "remote_devices_list"
          ? remoteDevices
          : null,
    ),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: <T,>(event: string, cb: (e: { payload: T }) => void) => {
    const list = eventListeners.get(event) ?? [];
    list.push(cb as (event: { payload: unknown }) => void);
    eventListeners.set(event, list);
    return Promise.resolve(() => {
      const next = (eventListeners.get(event) ?? []).filter((fn) => fn !== cb);
      eventListeners.set(event, next);
    });
  },
}));

vi.mock("../persist", () => ({
  readState: () => Promise.resolve(null),
  writeState: () => Promise.resolve(undefined),
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
    remoteDevices.length = 0;
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
    remoteDevices.length = 0;
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

  it("surfaces paired mobile devices separately from remote hosts", async () => {
    const { useHostInfo } = await import("./useHostInfo");
    const { _resetLocalHostCacheForTests } = await import("../hosts");
    _resetLocalHostCacheForTests();
    eventListeners.clear();
    remoteDevices.length = 0;
    remoteDevices.push({
      id: "dev-iphone",
      name: "iPhone",
      platform: "ios",
      createdAt: 1,
      lastSeenAt: 2,
      revoked: false,
      connected: true,
    });

    const { result } = renderHook(() => useHostInfo());

    await waitFor(() => {
      expect(result.current.hosts.find((h) => h.id === "device:dev-iphone")).toBeUndefined();
      const device = result.current.mobileDevices.find(
        (h) => h.id === "device:dev-iphone",
      );
      expect(device).toMatchObject({
        displayName: "iPhone",
        hostname: "ios",
        paired: true,
        connected: true,
        createdAt: 1,
        lastSeen: 2,
      });
      // Connection state travels on `connected` — never smuggled
      // through the TLS fingerprint field.
      expect(device?.fingerprintPrefix).toBeUndefined();
    });
  });
});
