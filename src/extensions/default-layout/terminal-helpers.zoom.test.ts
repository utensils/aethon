// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { observeTerminalUiScale } from "./terminal-helpers";

afterEach(() => {
  document.documentElement.style.removeProperty("--app-ui-scale");
  document.documentElement.style.zoom = "";
});

describe("observeTerminalUiScale", () => {
  it("ignores unchanged and invalid explicit scale events", () => {
    document.documentElement.style.setProperty("--app-ui-scale", "1.2");
    const onScale = vi.fn();
    const stop = observeTerminalUiScale(onScale);

    window.dispatchEvent(
      new CustomEvent("aethon:ui-scale-change", { detail: { scale: 1.2 } }),
    );
    window.dispatchEvent(
      new CustomEvent("aethon:ui-scale-change", { detail: { scale: 0 } }),
    );
    window.dispatchEvent(
      new CustomEvent("aethon:ui-scale-change", { detail: { scale: -1 } }),
    );

    expect(onScale).not.toHaveBeenCalled();
    stop();
  });

  it("emits changed positive explicit scale events", () => {
    document.documentElement.style.setProperty("--app-ui-scale", "1");
    const onScale = vi.fn();
    const stop = observeTerminalUiScale(onScale);

    window.dispatchEvent(
      new CustomEvent("aethon:ui-scale-change", { detail: { scale: 1.5 } }),
    );

    expect(onScale).toHaveBeenCalledWith(1.5);
    stop();
  });
});
