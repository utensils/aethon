import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTauriMocks, clearTauriMocks } from "../test/tauriMocks";
import {
  remoteDeviceRename,
  remoteDeviceRevoke,
  remoteDevicesList,
  remotePairingBegin,
  remotePairingCancel,
  remoteStatus,
} from "./remote";

describe("remote gateway service", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  it("reads gateway status without extra payload", async () => {
    harness.invoke.mockResolvedValueOnce({
      running: true,
      port: 4242,
      tlsActive: true,
      fingerprint: "ab".repeat(32),
      pairingActive: false,
      devices: 1,
    });

    await expect(remoteStatus()).resolves.toMatchObject({ port: 4242 });
    expect(harness.invoke).toHaveBeenCalledWith("remote_status");
  });

  it("begins and cancels pairing", async () => {
    harness.invoke.mockResolvedValueOnce({
      code: "12345678",
      expiresAt: 0,
      qrPayload: "{}",
    });
    await remotePairingBegin();
    await remotePairingCancel();

    expect(harness.invoke).toHaveBeenNthCalledWith(1, "remote_pairing_begin");
    expect(harness.invoke).toHaveBeenNthCalledWith(2, "remote_pairing_cancel");
  });

  it("lists, revokes, and renames devices with id payloads", async () => {
    harness.invoke.mockResolvedValueOnce([]);
    await remoteDevicesList();
    await remoteDeviceRevoke("dev-1");
    await remoteDeviceRename("dev-1", "James's iPhone");

    expect(harness.invoke).toHaveBeenNthCalledWith(1, "remote_devices_list");
    expect(harness.invoke).toHaveBeenNthCalledWith(2, "remote_device_revoke", {
      id: "dev-1",
    });
    expect(harness.invoke).toHaveBeenNthCalledWith(3, "remote_device_rename", {
      id: "dev-1",
      name: "James's iPhone",
    });
  });
});
