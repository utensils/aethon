// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// Tauri mocks: invoke returns a local host; listen exposes a hook so
// tests can fire host-discovered / host-removed payloads.
const eventListeners = new Map<string, Array<(event: { payload: unknown }) => void>>();

const remoteDevices: unknown[] = [];
const remoteHosts: unknown[] = [];
const remoteSnapshots = new Map<string, unknown>();

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
          : cmd === "remote_hosts_list"
            ? remoteHosts
            : cmd === "remote_host_project_snapshot"
              ? { hostId: "remote:bender", projects: remoteSnapshots.get("remote:bender") ?? {} }
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
    remoteHosts.length = 0;
    remoteSnapshots.clear();
    const { result } = renderHook(() => useHostInfo());
    await waitFor(() => {
      expect(result.current.localHostId).toBe("local:abc");
    });
    expect(result.current.activeHostId).toBe("local:abc");
    expect(result.current.hosts[0]?.isLocal).toBe(true);
  });

  it("removes unpaired discovered hosts when mDNS drops them", async () => {
    const { useHostInfo } = await import("./useHostInfo");
    const { _resetLocalHostCacheForTests } = await import("../hosts");
    _resetLocalHostCacheForTests();
    eventListeners.clear();
    remoteDevices.length = 0;
    remoteHosts.length = 0;
    remoteSnapshots.clear();
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
    remoteHosts.length = 0;
    remoteSnapshots.clear();
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

  it("surfaces paired desktop hosts and their remote project snapshot", async () => {
    const { useHostInfo } = await import("./useHostInfo");
    const { _resetLocalHostCacheForTests } = await import("../hosts");
    _resetLocalHostCacheForTests();
    eventListeners.clear();
    remoteDevices.length = 0;
    remoteHosts.length = 0;
    remoteSnapshots.clear();
    remoteHosts.push({
      id: "remote:bender",
      hostId: "local:bender",
      hostname: "bender.local",
      displayName: "bender",
      fingerprint: "bender",
      candidates: ["bender.local:4242"],
      createdAt: 1,
      lastSeenAt: 2,
    });
    remoteSnapshots.set("remote:bender", {
      projects: [{ id: "p1", label: "aethon", path: "/repo/aethon", uiExpanded: true }],
      workspacesByProject: {
        p1: [{ id: "w1", projectId: "p1", path: "/repo/aethon", branch: "main", isMain: true }],
      },
    });

    const { result } = renderHook(() => useHostInfo());

    await waitFor(() => {
      expect(result.current.hosts.find((h) => h.id === "remote:bender")).toMatchObject({
        displayName: "bender",
        paired: true,
        connected: false,
      });
      expect(result.current.remoteProjectsByHost["remote:bender"]?.[0]).toMatchObject({
        id: "remote:bender::project::p1",
        remoteId: "p1",
        label: "aethon",
        workspaces: [
          expect.objectContaining({
            id: "remote:bender::workspace::w1",
            remoteId: "w1",
            branch: "main",
          }),
        ],
      });
    });
  });

  it("keeps mDNS reachability separate from paired host connection state", async () => {
    const { useHostInfo } = await import("./useHostInfo");
    const { _resetLocalHostCacheForTests } = await import("../hosts");
    _resetLocalHostCacheForTests();
    eventListeners.clear();
    remoteDevices.length = 0;
    remoteHosts.length = 0;
    remoteSnapshots.clear();
    remoteHosts.push({
      id: "remote:bender",
      hostId: "local:bender",
      hostname: "bender.local",
      displayName: "bender",
      fingerprint: "bender",
      candidates: ["bender.local:4242"],
      createdAt: 1,
      lastSeenAt: 2,
    });

    const { result } = renderHook(() => useHostInfo());

    await waitFor(() => {
      expect(result.current.hosts.find((h) => h.id === "remote:bender")).toMatchObject({
        paired: true,
        connected: false,
      });
    });
    act(() => {
      fireEvent("host-discovered", {
        id: "remote:bender",
        hostname: "bender.local",
        displayName: "bender",
        fingerprintPrefix: "bender",
        candidates: ["bender.local:4242", "192.168.1.44:4242"],
        lastSeen: 3,
      });
    });
    await waitFor(() => {
      expect(result.current.hosts.find((h) => h.id === "remote:bender")).toMatchObject({
        paired: true,
        connected: false,
        candidates: ["bender.local:4242", "192.168.1.44:4242"],
      });
    });
    act(() => {
      fireEvent("host-removed", { id: "remote:bender" });
    });
    await waitFor(() => {
      expect(result.current.hosts.find((h) => h.id === "remote:bender")).toMatchObject({
        paired: true,
        connected: false,
      });
    });
    act(() => {
      fireEvent("remote-host-status-changed", {
        id: "remote:bender",
        connected: true,
      });
    });
    await waitFor(() => {
      expect(result.current.hosts.find((h) => h.id === "remote:bender")).toMatchObject({
        paired: true,
        connected: true,
      });
    });
  });

  it("does not surface desktop peer auth records as mobile devices", async () => {
    const { useHostInfo } = await import("./useHostInfo");
    const { _resetLocalHostCacheForTests } = await import("../hosts");
    _resetLocalHostCacheForTests();
    eventListeners.clear();
    remoteDevices.length = 0;
    remoteHosts.length = 0;
    remoteSnapshots.clear();
    remoteDevices.push({
      id: "dev-desktop",
      name: "bender",
      platform: "desktop",
      createdAt: 1,
      lastSeenAt: 2,
      revoked: false,
      connected: true,
    });

    const { result } = renderHook(() => useHostInfo());

    await waitFor(() => {
      expect(result.current.mobileDevices).toHaveLength(0);
    });
  });
});
