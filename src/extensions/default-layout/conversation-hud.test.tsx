// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationHud } from "./conversation-hud";

afterEach(() => cleanup());

describe("ConversationHud auto-listen toggle", () => {
  it("reflects auto-listen state on the switch", () => {
    const { rerender } = render(
      <ConversationHud
        phase="listening"
        error={null}
        autoListen={false}
        onPrimary={vi.fn()}
        onToggleAutoListen={vi.fn()}
        onExit={vi.fn()}
      />,
    );
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.className).not.toContain("a2ui-conversation-hud-auto-on");

    rerender(
      <ConversationHud
        phase="listening"
        error={null}
        autoListen={true}
        onPrimary={vi.fn()}
        onToggleAutoListen={vi.fn()}
        onExit={vi.fn()}
      />,
    );
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch").className).toContain(
      "a2ui-conversation-hud-auto-on",
    );
  });

  it("fires onToggleAutoListen when clicked", () => {
    const onToggleAutoListen = vi.fn();
    render(
      <ConversationHud
        phase="idle"
        error={null}
        autoListen={false}
        onPrimary={vi.fn()}
        onToggleAutoListen={onToggleAutoListen}
        onExit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onToggleAutoListen).toHaveBeenCalledTimes(1);
  });
});
