// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearConnection,
  connectionUrl,
  loadConnection,
  loadRememberedConnections,
  saveConnection,
} from "./mobileConnection";

function setSearch(search: string) {
  window.history.replaceState(null, "", `/${search}`);
}

function installMemoryStorage() {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
}

beforeEach(() => {
  installMemoryStorage();
});

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

  it("keeps remembered paired hosts after clearing the active connection", () => {
    saveConnection({
      host: "halcyon.local:48213",
      token: "tok",
      fingerprint: "ab".repeat(32),
      name: "halcyon",
    });

    clearConnection();

    expect(loadConnection()).toBeNull();
    expect(loadRememberedConnections()).toMatchObject([
      {
        host: "halcyon.local:48213",
        token: "tok",
        fingerprint: "ab".repeat(32),
        name: "halcyon",
      },
    ]);
  });

  it("dedupes remembered hosts by fingerprint", () => {
    const fp = "cd".repeat(32);
    saveConnection({ host: "old.local:1", token: "old", fingerprint: fp });
    saveConnection({ host: "new.local:2", token: "new", fingerprint: fp });

    expect(loadRememberedConnections()).toHaveLength(1);
    expect(loadRememberedConnections()[0]).toMatchObject({
      host: "new.local:2",
      token: "new",
      fingerprint: fp,
    });
  });
});
