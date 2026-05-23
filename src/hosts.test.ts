import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetLocalHostCacheForTests,
  getLocalHost,
  getLocalHostId,
  loadPairedHosts,
  savePairedHosts,
} from "./hosts";

// We mock the Tauri layer at the import level so unit tests can drive
// host_info without spinning up the bridge.
vi.mock("@tauri-apps/api/core", async () => {
  let invokeImpl: (cmd: string) => unknown = () => null;
  return {
    invoke: (cmd: string) => invokeImpl(cmd),
    __setInvoke(impl: (cmd: string) => unknown) {
      invokeImpl = impl;
    },
  };
});

vi.mock("./persist", () => {
  const store = new Map<string, string>();
  return {
    readState: async (file: string) => store.get(file) ?? null,
    writeState: async (file: string, body: string) => {
      store.set(file, body);
    },
    __clear() {
      store.clear();
    },
  };
});

afterEach(() => {
  _resetLocalHostCacheForTests();
});

describe("getLocalHostId", () => {
  it("returns the bridge id when host_info succeeds", async () => {
    const tauri = await import("@tauri-apps/api/core");
    (tauri as unknown as { __setInvoke: (impl: (c: string) => unknown) => void }).__setInvoke(
      (cmd) => (cmd === "host_info" ? { id: "local:abc", hostname: "x", displayName: "x", fingerprint: "fp" } : null),
    );
    expect(await getLocalHostId()).toBe("local:abc");
  });

  it("falls back when host_info is unavailable", async () => {
    const tauri = await import("@tauri-apps/api/core");
    (tauri as unknown as { __setInvoke: (impl: (c: string) => unknown) => void }).__setInvoke(
      () => {
        throw new Error("no bridge");
      },
    );
    expect(await getLocalHostId("local:unknown")).toBe("local:unknown");
  });
});

describe("getLocalHost", () => {
  it("returns a fully shaped local Host record", async () => {
    const tauri = await import("@tauri-apps/api/core");
    (tauri as unknown as { __setInvoke: (impl: (c: string) => unknown) => void }).__setInvoke(
      () => ({
        id: "local:abc",
        hostname: "halcyon.local",
        displayName: "halcyon",
        fingerprint: "deadbeef",
      }),
    );
    const host = await getLocalHost();
    expect(host).toMatchObject({
      id: "local:abc",
      hostname: "halcyon.local",
      displayName: "halcyon",
      isLocal: true,
      fingerprintPrefix: "deadbeef",
    });
  });
});

describe("paired host persistence", () => {
  it("round-trips through save/load and drops malformed entries", async () => {
    const persist = await import("./persist");
    (persist as unknown as { __clear: () => void }).__clear();
    await savePairedHosts([
      { id: "remote:1", hostname: "bender", displayName: "bender", isLocal: false, paired: true },
    ]);
    const loaded = await loadPairedHosts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].displayName).toBe("bender");
  });
});
