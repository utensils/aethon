// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useAppInteractions,
  type UseAppInteractionsContext,
} from "./useAppInteractions";

const mocks = vi.hoisted(() => ({
  eventHandler: vi.fn(),
  useAppEventRouting: vi.fn(),
  useKeyboardShortcuts: vi.fn(),
}));

vi.mock("../hooks/useAppEventRouting", () => ({
  useAppEventRouting: mocks.useAppEventRouting,
}));

vi.mock("../hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: mocks.useKeyboardShortcuts,
}));

describe("useAppInteractions", () => {
  it("mounts shortcuts and returns the routed A2UI event handler", () => {
    mocks.useAppEventRouting.mockReturnValue(mocks.eventHandler);
    const ctx = {
      stateRef: { current: {} },
    } as unknown as UseAppInteractionsContext;

    const { result } = renderHook(() => useAppInteractions(ctx));

    expect(mocks.useKeyboardShortcuts).toHaveBeenCalledWith(ctx);
    expect(mocks.useAppEventRouting).toHaveBeenCalledWith(ctx);
    expect(result.current).toBe(mocks.eventHandler);
  });
});
