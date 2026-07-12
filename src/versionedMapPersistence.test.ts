import { beforeEach, describe, expect, it, vi } from "vitest";

const { readState, writeState } = vi.hoisted(() => ({
  readState: vi.fn(),
  writeState: vi.fn(),
}));
vi.mock("./persist", () => ({ readState, writeState }));

import {
  createDebouncedMapWriter,
  parseVersionedMap,
  readVersionedMap,
  writeVersionedMap,
  type VersionedMapStore,
} from "./versionedMapPersistence";

const store: VersionedMapStore<number> = {
  file: "values.json",
  schemaVersion: 2,
  decodeEntry: (_key, value) =>
    typeof value === "number" ? value : undefined,
  encodeEntry: (_key, value) => value,
};

beforeEach(() => {
  readState.mockReset();
  writeState.mockReset().mockResolvedValue(true);
});

describe("versioned map persistence", () => {
  it("rejects invalid envelopes and drops malformed entries independently", () => {
    expect(parseVersionedMap("not json", store)).toEqual(new Map());
    expect(
      parseVersionedMap('{"schemaVersion":1,"entries":{"a":1}}', store),
    ).toEqual(new Map());
    expect(
      parseVersionedMap(
        '{"schemaVersion":2,"entries":{"valid":3,"bad":"3"}}',
        store,
      ),
    ).toEqual(new Map([["valid", 3]]));
  });

  it("reads and writes the typed versioned envelope", async () => {
    readState.mockResolvedValue(
      '{"schemaVersion":2,"entries":{"first":1}}',
    );
    await expect(readVersionedMap(store)).resolves.toEqual(
      new Map([["first", 1]]),
    );
    await writeVersionedMap(store, new Map([["second", 2]]));
    expect(writeState).toHaveBeenCalledWith(
      "values.json",
      '{"schemaVersion":2,"entries":{"second":2}}',
    );
  });

  it("debounces cloned snapshots and flushes only the latest", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const writer = createDebouncedMapWriter({ delayMs: 20, write });
    const mutable = new Map([["a", 1]]);
    writer.schedule(mutable);
    mutable.set("a", 2);
    writer.schedule(mutable);
    mutable.set("a", 3);

    await vi.advanceTimersByTimeAsync(20);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toEqual(new Map([["a", 2]]));
    vi.useRealTimers();
  });

  it("contains scheduled write failures while explicit flush reports them", async () => {
    vi.useFakeTimers();
    const failure = new Error("disk unavailable");
    const write = vi.fn().mockRejectedValue(failure);
    const writer = createDebouncedMapWriter({ delayMs: 20, write });

    writer.schedule(new Map([["a", 1]]));
    await vi.advanceTimersByTimeAsync(20);
    expect(write).toHaveBeenCalledOnce();

    writer.schedule(new Map([["b", 2]]));
    await expect(writer.flush()).rejects.toBe(failure);
    vi.useRealTimers();
  });
});
