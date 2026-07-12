// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAppStore, useAppState } from "./appStore";

describe("appStore", () => {
  it("applies value and updater writes while keeping stateRef fresh", () => {
    const store = createAppStore({ count: 0 });
    store.setState((prev) => ({ ...prev, count: 1 }));
    expect(store.getState().count).toBe(1);
    expect(store.stateRef.current.count).toBe(1);

    store.setState({ count: 2 });
    expect(store.getState().count).toBe(2);
    expect(store.stateRef.current.count).toBe(2);
  });

  it("notifies selector subscribers only when the selected value changes", () => {
    const store = createAppStore({ draft: "", status: "ready" });
    const listener = vi.fn();
    store.subscribeSelector((s) => s.draft, listener);

    store.setState((prev) => ({ ...prev, status: "thinking" }));
    expect(listener).not.toHaveBeenCalled();

    store.setState((prev) => ({ ...prev, draft: "hello" }));
    expect(listener).toHaveBeenCalledWith("hello", "");
  });

  it("does not rerender a selector consumer for unrelated store writes", () => {
    const store = createAppStore({ draft: "", status: "ready" });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useAppState(store, (state) => state.status);
    });

    act(() => store.setState((state) => ({ ...state, draft: "hello" })));

    expect(result.current).toBe("ready");
    expect(renders).toBe(1);

    act(() => store.setState((state) => ({ ...state, status: "thinking" })));

    expect(result.current).toBe("thinking");
    expect(renders).toBe(2);
  });

  it("preserves a selected object with a caller-provided equality", () => {
    const store = createAppStore({ draft: "", status: "ready" });
    const equality = (a: { status: unknown }, b: { status: unknown }) =>
      Object.is(a.status, b.status);
    const { result } = renderHook(() =>
      useAppState(store, (state) => ({ status: state.status }), equality),
    );
    const first = result.current;

    act(() => store.setState((state) => ({ ...state, draft: "hello" })));

    expect(result.current).toBe(first);
  });
});
