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
  it("races all candidates concurrently and resolves with the first success", async () => {
    // The dead host hangs well past the winner — serial iteration
    // would have waited it out; the race must not.
    const invokeFn = vi.fn((_cmd: string, args: Record<string, unknown>) => {
      if (args.host === "192.168.1.10:48213") {
        return new Promise(() => undefined); // never settles
      }
      return Promise.resolve({
        deviceId: "dev-1",
        deviceToken: "tok-1",
        hostDisplayName: "halcyon",
        hostFingerprint: PAYLOAD.fp,
      });
    });
    const { connection, outcome } = await pairWithHosts({
      hosts: PAYLOAD.hosts,
      port: PAYLOAD.port,
      fingerprint: PAYLOAD.fp,
      code: PAYLOAD.code,
      invokeFn,
    });
    // Both candidates were attempted in parallel.
    expect(invokeFn).toHaveBeenCalledTimes(2);
    expect(connection).toEqual({
      host: "halcyon.local:48213",
      token: "tok-1",
      fingerprint: PAYLOAD.fp,
      name: "halcyon",
    });
    expect(outcome.deviceId).toBe("dev-1");
  });

  it("prefers a server verdict over transport noise when every host fails", async () => {
    const invokeFn = vi.fn((_cmd: string, args: Record<string, unknown>) =>
      args.host === "192.168.1.10:48213"
        ? Promise.reject(new Error("net:timed out"))
        : Promise.reject(new Error("pair:403:wrong code")),
    );
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
