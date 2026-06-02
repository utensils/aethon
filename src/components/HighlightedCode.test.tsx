// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HighlightedCode } from "./HighlightedCode";

vi.mock("../utils/highlight", () => ({
  getCachedHighlight: vi.fn(() => null),
  highlightCode: vi.fn(() => Promise.resolve(null)),
}));

describe("HighlightedCode", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => cleanup());

  it("renders syntax blocks as framed, copyable code", async () => {
    const { container } = render(
      <HighlightedCode code={"koban --help\n"} language="bash" />,
    );

    const frame = container.querySelector(".a2ui-code-frame");
    expect(frame?.getAttribute("data-language")).toBe("bash");
    expect(screen.getByText("bash").classList.contains("a2ui-code-title")).toBe(
      true,
    );
    expect(container.querySelector("pre.a2ui-code")?.textContent).toBe(
      "koban --help",
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copied code" }),
      ).not.toBeNull(),
    );
    expect(writeText).toHaveBeenCalledWith("koban --help");
  });

  it("does not claim copied when the clipboard write rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<HighlightedCode code={"koban --help\n"} language="bash" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("koban --help"));
    expect(screen.queryByRole("button", { name: "Copied code" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy code" })).not.toBeNull();
  });

  it("labels unlabeled fenced blocks as text without using the compact text chip", () => {
    const { container } = render(<HighlightedCode code="plain command" />);

    expect(container.querySelector(".a2ui-code-frame")).not.toBeNull();
    expect(
      container
        .querySelector(".a2ui-code-frame")
        ?.getAttribute("data-language"),
    ).toBe("plain");
    expect(screen.getByText("text").classList.contains("a2ui-code-title")).toBe(
      true,
    );
  });

  it("preserves compact rendering for explicit text primitives", () => {
    const { container } = render(
      <HighlightedCode code="/Users/jamesbrink/project" language="text" />,
    );

    expect(container.querySelector(".a2ui-code-frame")).toBeNull();
    expect(
      container.querySelector("pre.a2ui-code")?.getAttribute("data-language"),
    ).toBe("text");
  });
});
