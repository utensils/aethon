// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((cmd: string, _args?: unknown) => {
  if (cmd === "updater_available") return Promise.resolve(true);
  if (cmd === "check_for_updates_with_channel") return Promise.resolve(null);
  return Promise.resolve(undefined);
});

const listen = vi.fn((_event: string, _cb: unknown) => Promise.resolve(vi.fn()));
const getConfig = vi.fn(() =>
  Promise.resolve({
    updates: { channel: "nightly", disableAutoCheck: false },
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: unknown) => listen(event, cb),
}));

vi.mock("../config", () => ({
  getConfig: () => getConfig(),
}));

describe("useUpdater", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("DEV", false);
    invoke.mockClear();
    listen.mockClear();
    getConfig.mockClear();
  });

  it("does not restart the production auto-check when parent callbacks change identity", async () => {
    const { useUpdater } = await import("./useUpdater");

    const { rerender } = renderHook(
      ({ tick }: { tick: number }) =>
        useUpdater({
          appendSystem: vi.fn((_text: string) => tick),
          __testAutoCheck: true,
        }),
      { initialProps: { tick: 0 } },
    );

    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(
          ([cmd]) => cmd === "check_for_updates_with_channel",
        ),
      ).toHaveLength(1),
    );
    expect(invoke).toHaveBeenCalledWith("check_for_updates_with_channel", {
      channel: "nightly",
    });

    act(() => {
      rerender({ tick: 1 });
    });

    expect(
      invoke.mock.calls.filter(
        ([cmd]) => cmd === "check_for_updates_with_channel",
      ),
    ).toHaveLength(1);
  });
});
