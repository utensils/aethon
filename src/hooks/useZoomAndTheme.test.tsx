// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTauriMocks, type TauriMockHarness } from "../test/tauriMocks";
import { useZoomAndTheme } from "./useZoomAndTheme";

describe("useZoomAndTheme", () => {
  let harness: TauriMockHarness;

  beforeEach(() => {
    harness = installTauriMocks();
    document.documentElement.dataset.theme = "ember";
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits theme changes from the desktop surface for paired clients", async () => {
    const setState = vi.fn();
    const { result } = renderHook(() =>
      useZoomAndTheme({
        setState,
        pushNotification: vi.fn(),
      }),
    );

    act(() => result.current.setTheme("paper"));

    expect(document.documentElement.dataset.theme).toBe("paper");
    await waitFor(() =>
      expect(harness.emit).toHaveBeenCalledWith("theme-changed", { id: "paper" }),
    );
  });

  it("applies remote theme events on mobile without echoing them back", async () => {
    vi.stubEnv("VITE_AETHON_SURFACE", "mobile");
    const setState = vi.fn();
    renderHook(() =>
      useZoomAndTheme({
        setState,
        pushNotification: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(harness.listen).toHaveBeenCalledWith(
        "theme-changed",
        expect.any(Function),
      ),
    );
    act(() => {
      harness.fireEvent("frontend-state", { theme: "brink" });
    });

    expect(document.documentElement.dataset.theme).toBe("brink");
    expect(harness.invoke).not.toHaveBeenCalledWith("set_theme", expect.anything());
    expect(harness.emit).not.toHaveBeenCalledWith("theme-changed", expect.anything());
  });
});
