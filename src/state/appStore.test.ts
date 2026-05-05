import { describe, expect, it, vi } from "vitest";
import { createAppStore } from "./appStore";

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
});
