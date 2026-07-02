// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { connectionUrl, loadConnection } from "./mobileConnection";

function setSearch(search: string) {
  window.history.replaceState(null, "", `/${search}`);
}

afterEach(() => {
  setSearch("");
  localStorage.clear();
});

describe("loadConnection URL override", () => {
  it("reads gateway + token as the plaintext dev path", () => {
    setSearch("?gateway=ws://10.0.0.5:9000&token=tok");
    expect(loadConnection()).toEqual({
      host: "10.0.0.5:9000",
      token: "tok",
      fingerprint: undefined,
    });
  });

  it("pins the cert when fp is present, flipping the transport to wss", () => {
    const fp = "ab".repeat(32);
    setSearch(`?gateway=wss://10.0.0.5:9000/ws&token=tok&fp=${fp}`);
    const connection = loadConnection();
    expect(connection).toEqual({ host: "10.0.0.5:9000", token: "tok", fingerprint: fp });
    expect(connectionUrl(connection!)).toBe("wss://10.0.0.5:9000/ws");
  });

  it("falls back to storage when params are absent", () => {
    localStorage.setItem(
      "aethon-mobile-connection",
      JSON.stringify({ host: "h:1", token: "t" }),
    );
    expect(loadConnection()).toEqual({ host: "h:1", token: "t" });
  });
});
