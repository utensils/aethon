// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "./chat";

afterEach(() => cleanup());

function renderInput(onEvent = vi.fn()) {
  render(
    <ChatInput
      component={{
        id: "chat-input",
        type: "chat-input",
        props: { value: "", placeholder: "Message" },
      }}
      state={{}}
      onEvent={onEvent}
    />,
  );
  return {
    input: screen.getByPlaceholderText("Message"),
    onEvent,
  };
}

describe("ChatInput", () => {
  it("submits bare Enter as a normal queued-capable message", () => {
    const { input, onEvent } = renderInput();

    fireEvent.change(input, { target: { value: "queue this" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onEvent).toHaveBeenLastCalledWith("submit", {
      value: "queue this",
      mode: "normal",
    });
  });

  it("submits command-enter as a steering message", () => {
    const { input, onEvent } = renderInput();

    fireEvent.change(input, { target: { value: "steer this" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    expect(onEvent).toHaveBeenLastCalledWith("submit", {
      value: "steer this",
      mode: "steer",
    });
  });

  it("submits ctrl-enter as a steering message for non-mac keyboards", () => {
    const { input, onEvent } = renderInput();

    fireEvent.change(input, { target: { value: "steer with ctrl" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    expect(onEvent).toHaveBeenLastCalledWith("submit", {
      value: "steer with ctrl",
      mode: "steer",
    });
  });

  it("does not submit shift-enter", () => {
    const { input, onEvent } = renderInput();

    fireEvent.change(input, { target: { value: "new line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(onEvent).not.toHaveBeenCalledWith("submit", expect.any(Object));
  });
});
