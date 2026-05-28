// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToggleSwitch } from "./toggle-switch";

afterEach(() => cleanup());

describe("ToggleSwitch", () => {
  it("renders with role=switch and the correct aria-checked", () => {
    render(
      <ToggleSwitch
        checked
        ariaLabel="Toggle thing"
        onChange={() => {}}
      />,
    );
    const sw = screen.getByRole("switch", { name: "Toggle thing" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("fires onChange with the inverted value on click", () => {
    const onChange = vi.fn();
    render(
      <ToggleSwitch
        checked={false}
        ariaLabel="Toggle thing"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("activates on Space and Enter", () => {
    const onChange = vi.fn();
    render(
      <ToggleSwitch
        checked
        ariaLabel="Toggle thing"
        onChange={onChange}
      />,
    );
    const sw = screen.getByRole("switch");
    fireEvent.keyDown(sw, { key: " " });
    fireEvent.keyDown(sw, { key: "Enter" });
    expect(onChange).toHaveBeenNthCalledWith(1, false);
    expect(onChange).toHaveBeenNthCalledWith(2, false);
  });

  it("ignores activation while disabled", () => {
    const onChange = vi.fn();
    render(
      <ToggleSwitch
        checked={false}
        disabled
        ariaLabel="Toggle thing"
        onChange={onChange}
      />,
    );
    const sw = screen.getByRole("switch");
    fireEvent.click(sw);
    fireEvent.keyDown(sw, { key: " " });
    expect(onChange).not.toHaveBeenCalled();
    expect(sw.getAttribute("aria-disabled")).toBe("true");
  });

  it("stops click propagation so a parent row's click handler does not fire", () => {
    const onChange = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <ToggleSwitch
          checked={false}
          ariaLabel="Toggle thing"
          onChange={onChange}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
  });
});
