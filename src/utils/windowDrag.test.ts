// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  isInteractiveTarget,
  onWindowDragMouseDown,
  startWindowDrag,
  toggleMaximizeWindow,
} from "./windowDrag";

// Capture every plugin:window command the helpers fire.
const invoke = vi.fn(() => Promise.resolve());

beforeEach(() => {
  invoke.mockClear();
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke,
  };
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
});

/** Build a minimal React-like mousedown event over a target tree. */
function dragEvent(
  target: HTMLElement,
  currentTarget: HTMLElement,
  detail = 1,
  button = 0,
): { event: ReactMouseEvent<HTMLElement>; preventDefault: ReturnType<typeof vi.fn> } {
  const preventDefault = vi.fn();
  const event = {
    button,
    detail,
    target,
    currentTarget,
    preventDefault,
  } as unknown as ReactMouseEvent<HTMLElement>;
  return { event, preventDefault };
}

describe("isInteractiveTarget", () => {
  it("treats a plain span inside the boundary as draggable", () => {
    const boundary = document.createElement("div");
    const span = document.createElement("span");
    boundary.appendChild(span);
    expect(isInteractiveTarget(span, boundary)).toBe(false);
  });

  it("blocks drag when the target is (or is within) a button", () => {
    const boundary = document.createElement("div");
    const button = document.createElement("button");
    const label = document.createElement("span");
    button.appendChild(label);
    boundary.appendChild(button);
    expect(isInteractiveTarget(button, boundary)).toBe(true);
    expect(isInteractiveTarget(label, boundary)).toBe(true);
  });

  it("blocks an interactive role, a focusable tabindex, and data-no-drag", () => {
    const boundary = document.createElement("div");
    const role = document.createElement("div");
    role.setAttribute("role", "menuitem");
    const focusable = document.createElement("div");
    focusable.setAttribute("tabindex", "0");
    const noDrag = document.createElement("div");
    noDrag.setAttribute("data-no-drag", "");
    for (const el of [role, focusable, noDrag]) boundary.appendChild(el);
    expect(isInteractiveTarget(role, boundary)).toBe(true);
    expect(isInteractiveTarget(focusable, boundary)).toBe(true);
    expect(isInteractiveTarget(noDrag, boundary)).toBe(true);
  });

  it("ignores tabindex of -1 (programmatic focus, not interactive)", () => {
    const boundary = document.createElement("div");
    const el = document.createElement("div");
    el.setAttribute("tabindex", "-1");
    boundary.appendChild(el);
    expect(isInteractiveTarget(el, boundary)).toBe(false);
  });
});

describe("startWindowDrag / toggleMaximizeWindow", () => {
  it("fire the matching plugin:window commands", () => {
    startWindowDrag();
    expect(invoke).toHaveBeenCalledWith("plugin:window|start_dragging");
    toggleMaximizeWindow();
    expect(invoke).toHaveBeenCalledWith(
      "plugin:window|internal_toggle_maximize",
    );
  });

  it("swallows a rejected invoke instead of throwing", () => {
    invoke.mockReturnValueOnce(Promise.reject(new Error("denied")));
    expect(() => startWindowDrag()).not.toThrow();
  });
});

describe("onWindowDragMouseDown", () => {
  it("starts a drag on a single left click over non-interactive chrome", () => {
    const boundary = document.createElement("div");
    const span = document.createElement("span");
    boundary.appendChild(span);
    const { event, preventDefault } = dragEvent(span, boundary, 1);
    onWindowDragMouseDown(event);
    expect(preventDefault).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("plugin:window|start_dragging");
  });

  it("toggles maximize on a double click", () => {
    const boundary = document.createElement("div");
    const { event } = dragEvent(boundary, boundary, 2);
    onWindowDragMouseDown(event);
    expect(invoke).toHaveBeenCalledWith(
      "plugin:window|internal_toggle_maximize",
    );
    expect(invoke).not.toHaveBeenCalledWith("plugin:window|start_dragging");
  });

  it("does nothing for a non-left button", () => {
    const boundary = document.createElement("div");
    const { event, preventDefault } = dragEvent(boundary, boundary, 1, 2);
    onWindowDragMouseDown(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("lets clicks on interactive controls through (no drag)", () => {
    const boundary = document.createElement("div");
    const button = document.createElement("button");
    boundary.appendChild(button);
    const { event, preventDefault } = dragEvent(button, boundary, 1);
    onWindowDragMouseDown(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
