// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("../gateway/rustBridgeAdapter", () => ({
  isTauriRuntime: () => true,
}));

import { useNearbyDesktops } from "./useNearbyDesktops";

const DESKTOP = {
  id: "remote:ff",
  name: "halcyon",
  host: "halcyon.local:48213",
  hostname: "halcyon.local",
  port: 48213,
  fingerprint: "ff".repeat(32),
  version: "0.11.2",
};

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useNearbyDesktops", () => {
  it("polls discovery_scan and exposes the sorted snapshot", async () => {
    invokeMock.mockResolvedValue([
      { ...DESKTOP, name: "zeta", id: "remote:zz", fingerprint: "zz" },
      DESKTOP,
    ]);
    const { result, unmount } = renderHook(() => useNearbyDesktops(true));
    await waitFor(() => expect(result.current.desktops).toHaveLength(2));
    expect(invokeMock).toHaveBeenCalledWith("discovery_scan", { timeoutMs: 2500 });
    expect(result.current.desktops.map((d) => d.name)).toEqual(["halcyon", "zeta"]);
    expect(result.current.error).toBeNull();
    unmount();
  });

  it("does not scan when disabled", async () => {
    const { result } = renderHook(() => useNearbyDesktops(false));
    await act(async () => {
      await Promise.resolve();
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.desktops).toEqual([]);
  });

  it("surfaces scan errors without clearing on unmount races", async () => {
    invokeMock.mockRejectedValue(new Error("discovery unsupported on this platform"));
    const { result, unmount } = renderHook(() => useNearbyDesktops(true));
    await waitFor(() => expect(result.current.error).toMatch(/unsupported/));
    unmount();
  });
});
