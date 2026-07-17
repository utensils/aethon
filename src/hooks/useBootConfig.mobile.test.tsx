// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTauriMocks, type TauriMockHarness } from "../test/tauriMocks";
import { useBootConfig } from "./useBootConfig";

describe("useBootConfig on mobile", () => {
  let harness: TauriMockHarness;

  beforeEach(() => {
    harness = installTauriMocks();
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.stubEnv("VITE_AETHON_SURFACE", "mobile");
    document.documentElement.style.zoom = "";
    document.documentElement.style.removeProperty("--app-ui-scale");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    document.documentElement.style.zoom = "";
    document.documentElement.style.removeProperty("--app-ui-scale");
  });

  it("does not apply the paired desktop's persisted UI zoom", async () => {
    harness.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "read_state") {
        return Promise.resolve(
          (args as { name?: string } | undefined)?.name === "ui_zoom"
            ? "1.2"
            : "",
        );
      }
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() =>
      useBootConfig({
        setState: vi.fn(),
        piDefaultModelRef: { current: "" },
      }),
    );

    await waitFor(() => expect(result.current.bootConfigReady).toBe(true));

    expect(document.documentElement.style.zoom).toBe("");
    expect(
      document.documentElement.style.getPropertyValue("--app-ui-scale"),
    ).toBe("");
    expect(harness.invoke).not.toHaveBeenCalledWith("read_state", {
      name: "ui_zoom",
    });
  });

  it("continues to restore persisted UI zoom on desktop", async () => {
    vi.stubEnv("VITE_AETHON_SURFACE", "desktop");
    harness.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "read_state") {
        return Promise.resolve(
          (args as { name?: string } | undefined)?.name === "ui_zoom"
            ? "1.2"
            : "",
        );
      }
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() =>
      useBootConfig({
        setState: vi.fn(),
        piDefaultModelRef: { current: "" },
      }),
    );

    await waitFor(() => expect(result.current.bootConfigReady).toBe(true));

    expect(document.documentElement.style.zoom).toBe("1.2");
    expect(
      document.documentElement.style.getPropertyValue("--app-ui-scale"),
    ).toBe("1.2");
  });
});
