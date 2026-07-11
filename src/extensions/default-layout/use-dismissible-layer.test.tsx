// @vitest-environment jsdom

import { fireEvent, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDismissibleLayer } from "./use-dismissible-layer";

describe("useDismissibleLayer", () => {
  it("dismisses on Escape, resize, and an outside pointer only", () => {
    const inside = document.createElement("div");
    const child = document.createElement("button");
    inside.append(child);
    document.body.append(inside);
    const insideRef = createRef<HTMLDivElement>();
    insideRef.current = inside;
    const onDismiss = vi.fn();

    renderHook(() =>
      useDismissibleLayer({
        active: true,
        onDismiss,
        insideRefs: [insideRef],
        dismissOnPointerOutside: true,
        dismissOnResize: true,
      }),
    );

    fireEvent.mouseDown(child);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent(window, new Event("resize"));
    expect(onDismiss).toHaveBeenCalledTimes(3);
    inside.remove();
  });

  it("does not install dismissal while inactive", () => {
    const onDismiss = vi.fn();
    renderHook(() => useDismissibleLayer({ active: false, onDismiss }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
