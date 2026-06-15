// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyUiScale } from "./viewport";

afterEach(() => {
  document.documentElement.style.removeProperty("--app-ui-scale");
  document.documentElement.style.zoom = "";
});

describe("applyUiScale", () => {
  it("dispatches ui-scale changes only when the scale changes", () => {
    const listener = vi.fn();
    window.addEventListener("aethon:ui-scale-change", listener);

    applyUiScale(1.2);
    applyUiScale(1.2);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      detail: { scale: 1.2 },
    });

    window.removeEventListener("aethon:ui-scale-change", listener);
  });
});
