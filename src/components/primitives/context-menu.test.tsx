// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ContextMenu, type ContextMenuItem } from "./context-menu";

afterEach(() => {
  cleanup();
});

function items(extra: ContextMenuItem[] = []): ContextMenuItem[] {
  return [
    { id: "rename", label: "Rename", onSelect: () => {} },
    { type: "separator" },
    { id: "delete", label: "Delete", danger: true, onSelect: () => {} },
    ...extra,
  ];
}

describe("ContextMenu", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  });

  it("renders the items when open", () => {
    render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={items()}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByText("Rename")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
  });

  it("does not render when closed", () => {
    render(
      <ContextMenu
        open={false}
        x={100}
        y={100}
        items={items()}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("calls onSelect + onClose on Enter on the focused item", () => {
    const onRename = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={[
          { id: "rename", label: "Rename", onSelect: onRename },
          { id: "delete", label: "Delete", onSelect: () => {} },
        ]}
        onClose={onClose}
      />,
    );
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ArrowDown advances focus past separators", () => {
    render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={[
          { id: "a", label: "A", onSelect: () => {} },
          { type: "separator" },
          { id: "b", label: "B", onSelect: () => {} },
        ]}
        onClose={() => {}}
      />,
    );
    const menu = screen.getByRole("menu");
    // First item focused on open.
    expect(menu.getAttribute("aria-activedescendant")).toMatch(/i0$/);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    // Index 1 is a separator; focus should advance to index 2.
    expect(menu.getAttribute("aria-activedescendant")).toMatch(/i2$/);
  });

  it("ArrowUp wraps to the last focusable item", () => {
    render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={[
          { id: "a", label: "A", onSelect: () => {} },
          { id: "b", label: "B", onSelect: () => {} },
        ]}
        onClose={() => {}}
      />,
    );
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(menu.getAttribute("aria-activedescendant")).toMatch(/i1$/);
  });

  it("Escape closes the menu", () => {
    const onClose = vi.fn();
    render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={items()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Outside mousedown closes the menu", () => {
    const onClose = vi.fn();
    render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={items()}
        onClose={onClose}
      />,
    );
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clamps to viewport when opened near the right edge", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    render(
      <ContextMenu
        open
        x={390}
        y={100}
        items={items()}
        estimatedWidth={220}
        estimatedHeight={120}
        onClose={() => {}}
      />,
    );
    const menu = screen.getByRole("menu");
    const left = parseInt(menu.style.left, 10);
    // 220-wide menu + 8px inset must fit inside 400-wide viewport.
    expect(left).toBeLessThanOrEqual(400 - 220 - 8);
  });

  it("renders danger items with is-danger class", () => {
    render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={[
          { id: "delete", label: "Delete", danger: true, onSelect: () => {} },
        ]}
        onClose={() => {}}
      />,
    );
    const btn = screen.getByText("Delete").closest("button");
    expect(btn?.className).toContain("is-danger");
  });

  it("skips disabled items in keyboard navigation", () => {
    render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={[
          { id: "a", label: "A", disabled: true, onSelect: () => {} },
          { id: "b", label: "B", onSelect: () => {} },
        ]}
        onClose={() => {}}
      />,
    );
    const menu = screen.getByRole("menu");
    // First focused index should be the first focusable (non-disabled) item.
    expect(menu.getAttribute("aria-activedescendant")).toMatch(/i1$/);
  });

  it("does not invoke onSelect when the disabled item is clicked", () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={[
          { id: "a", label: "A", disabled: true, onSelect },
        ]}
        onClose={() => {}}
      />,
    );
    const btn = screen.getByText("A").closest("button")!;
    act(() => {
      fireEvent.click(btn);
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders separator + header + note items without making them focusable", () => {
    render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={[
          { type: "header", label: "Section" },
          { id: "rename", label: "Rename", onSelect: () => {} },
          { type: "separator" },
          { type: "note", label: "Restart Aethon to fully unload" },
        ]}
        onClose={() => {}}
      />,
    );
    // Header + note render as non-buttons; only one menuitem present.
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  });

  it("keeps focus in an inline input when parent state re-renders", async () => {
    const buildItems = (): ContextMenuItem[] => [
      {
        type: "input",
        id: "rename-session",
        label: "Session name",
        defaultValue: "Tab 1",
        onSubmit: () => {},
      },
      { type: "separator" },
      { id: "close-tab", label: "Close tab", onSelect: () => {} },
    ];
    const { rerender } = render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={buildItems()}
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByLabelText("Session name"),
      );
    });

    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Planning" },
    });
    rerender(
      <ContextMenu
        open
        x={100}
        y={100}
        items={buildItems()}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const input = screen.getByLabelText("Session name");
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty("value", "Planning");
  });

  it("lets Enter submit inline input forms instead of activating a menu item", async () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={[
          {
            type: "input",
            id: "rename-session",
            label: "Session name",
            defaultValue: "Tab 1",
            onSubmit,
          },
          { id: "close-tab", label: "Close tab", onSelect },
        ]}
        onClose={onClose}
      />,
    );

    const input = screen.getByLabelText("Session name");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: "Planning" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.submit(input.closest("form")!);

    expect(onSubmit).toHaveBeenCalledWith("Planning");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clamps virtual focus when items change while the menu remains open", () => {
    const onAlpha = vi.fn();
    const onBeta = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <ContextMenu
        open
        x={100}
        y={100}
        items={[
          { id: "alpha", label: "Alpha", onSelect: onAlpha },
          { id: "beta", label: "Beta", onSelect: onBeta },
        ]}
        onClose={onClose}
      />,
    );

    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(menu.getAttribute("aria-activedescendant")).toMatch(/i1$/);

    rerender(
      <ContextMenu
        open
        x={100}
        y={100}
        items={[{ id: "alpha", label: "Alpha", onSelect: onAlpha }]}
        onClose={onClose}
      />,
    );

    expect(menu.getAttribute("aria-activedescendant")).toMatch(/i0$/);
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onAlpha).toHaveBeenCalledTimes(1);
    expect(onBeta).not.toHaveBeenCalled();
  });
});
