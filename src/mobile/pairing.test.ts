import { describe, expect, it, vi } from "vitest";

import {
  classifyPairError,
  pairErrorMessage,
  pairWithHosts,
  parseQrPayload,
} from "./pairing";

const PAYLOAD = {
  v: 1,
  name: "halcyon",
  hosts: ["192.168.1.10", "halcyon.local"],
  port: 48213,
  fp: "ab".repeat(32),
  code: "12345678",
};

describe("parseQrPayload", () => {
  it("accepts the desktop's payload shape", () => {
    expect(parseQrPayload(JSON.stringify(PAYLOAD))).toEqual(PAYLOAD);
  });

  it("rejects wrong versions, bad codes, and garbage", () => {
    expect(parseQrPayload(JSON.stringify({ ...PAYLOAD, v: 2 }))).toBeNull();
    expect(parseQrPayload(JSON.stringify({ ...PAYLOAD, code: "1234" }))).toBeNull();
    expect(parseQrPayload(JSON.stringify({ ...PAYLOAD, hosts: [] }))).toBeNull();
    expect(parseQrPayload("https://example.com/some-other-qr")).toBeNull();
    expect(parseQrPayload("{not json")).toBeNull();
  });
});

describe("classifyPairError", () => {
  it("splits the pair.rs contract into net vs pair verdicts", () => {
    const net = classifyPairError("net:connect refused");
    expect(net.kind).toBe("net");
    expect(net.message).toBe("connect refused");
    const pair = classifyPairError("pair:403:wrong code");
    expect(pair.kind).toBe("pair");
    expect(pair.status).toBe(403);
    expect(pair.message).toBe("wrong code");
    // Tauri invoke rejections may arrive wrapped in an Error.
    expect(classifyPairError(new Error("pair:410:pairing window expired")).status).toBe(410);
  });

  it("spells out the expiry window for 410/404", () => {
    expect(pairErrorMessage(classifyPairError("pair:410:pairing window expired"))).toMatch(
      /Pairing window expired/,
    );
    expect(pairErrorMessage(classifyPairError("pair:404:pairing not active"))).toMatch(
      /Pairing window expired/,
    );
    expect(pairErrorMessage(classifyPairError("pair:403:wrong code"))).toMatch(/wrong code/);
  });
});

describe("pairWithHosts", () => {
  it("falls through net failures and returns the first success", async () => {
    const invokeFn = vi
      .fn()
      .mockRejectedValueOnce("net:timed out connecting to 100.1.2.3:48213")
      .mockResolvedValueOnce({
        deviceId: "dev-1",
        deviceToken: "tok-1",
        hostDisplayName: "halcyon",
        hostFingerprint: PAYLOAD.fp,
      });
    const { connection, outcome } = await pairWithHosts({
      hosts: PAYLOAD.hosts,
      port: PAYLOAD.port,
      fingerprint: PAYLOAD.fp,
      code: PAYLOAD.code,
      invokeFn,
    });
    expect(invokeFn).toHaveBeenCalledTimes(2);
    expect(invokeFn).toHaveBeenLastCalledWith("gateway_pair", {
      host: "halcyon.local:48213",
      fingerprint: PAYLOAD.fp,
      code: PAYLOAD.code,
      deviceName: "iPhone",
    });
    expect(connection).toEqual({
      host: "halcyon.local:48213",
      token: "tok-1",
      fingerprint: PAYLOAD.fp,
    });
    expect(outcome.deviceId).toBe("dev-1");
  });

  it("stops immediately on a server verdict — no attempt-budget burn", async () => {
    const invokeFn = vi.fn().mockRejectedValue("pair:403:wrong code");
    const err = await pairWithHosts({
      hosts: PAYLOAD.hosts,
      port: PAYLOAD.port,
      fingerprint: PAYLOAD.fp,
      code: "00000000",
      invokeFn,
    }).then(
      () => null,
      (e: unknown) => classifyPairError(e),
    );
    expect(err?.kind).toBe("pair");
    expect(err?.status).toBe(403);
    expect(invokeFn).toHaveBeenCalledTimes(1);
  });

  it("omits the fingerprint field for the plaintext dev path", async () => {
    const invokeFn = vi.fn().mockResolvedValue({
      deviceId: "d",
      deviceToken: "t",
      hostDisplayName: "h",
      hostFingerprint: "",
    });
    const { connection } = await pairWithHosts({
      hosts: ["localhost"],
      port: 1234,
      fingerprint: "",
      code: PAYLOAD.code,
      invokeFn,
    });
    expect(connection.fingerprint).toBeUndefined();
  });
});
