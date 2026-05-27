// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { useSettingsOverlay } from "./settings";
import type { UseUiOverlaysContext } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function buildContext(initialState: Record<string, unknown>): {
  ctx: Pick<
    UseUiOverlaysContext,
    "setState" | "stateRef" | "reapplyConfig" | "pushNotification"
  >;
  stateRef: MutableRefObject<Record<string, unknown>>;
} {
  const stateRef: MutableRefObject<Record<string, unknown>> = {
    current: initialState,
  };
  const setState: Dispatch<SetStateAction<Record<string, unknown>>> = (arg) => {
    stateRef.current = typeof arg === "function" ? arg(stateRef.current) : arg;
  };
  return {
    stateRef,
    ctx: {
      setState,
      stateRef,
      reapplyConfig: vi.fn(),
      pushNotification: vi.fn(),
    },
  };
}

describe("useSettingsOverlay", () => {
  it("preserves the focused settings section while applying pending patches", () => {
    const { ctx, stateRef } = buildContext({
      settings: {
        open: true,
        pending: null,
        focusSection: "extensions",
      },
    });

    const settings = useSettingsOverlay(ctx);

    settings.applySettingsPatch({ ui: { theme: "aether" } });

    expect(stateRef.current.settings).toEqual({
      open: true,
      pending: { ui: { theme: "aether" } },
      focusSection: "extensions",
    });
  });
});
