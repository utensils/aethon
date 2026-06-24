// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AethonConfig } from "../config";
import { useUpdaterConfigBridge } from "./useUpdaterConfigBridge";

const config = {
  updates: { channel: "nightly", disableAutoCheck: true },
} as AethonConfig;

describe("useUpdaterConfigBridge", () => {
  it("reapplies config and immediately mirrors updater settings", () => {
    const reapplyConfig = vi.fn();
    const setUpdateChannel = vi.fn();
    const setUpdateDisableAutoCheck = vi.fn();
    const { result } = renderHook(() =>
      useUpdaterConfigBridge({
        reapplyConfig,
        setUpdateChannel,
        setUpdateDisableAutoCheck,
      }),
    );

    result.current(config);

    expect(reapplyConfig).toHaveBeenCalledWith(config);
    expect(setUpdateChannel).toHaveBeenCalledWith("nightly");
    expect(setUpdateDisableAutoCheck).toHaveBeenCalledWith(true);
  });
});
