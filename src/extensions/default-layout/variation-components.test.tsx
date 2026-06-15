// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ModelPicker } from "./variation-components";

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ModelPicker", () => {
  it("emits the selected model id from the rendered dropdown", () => {
    const onEvent = vi.fn();
    render(
      <ModelPicker
        component={{ id: "model-picker", type: "model-picker", props: {} }}
        state={{
          model: "anthropic/claude-opus-4-7",
          sidebar: {
            models: [
              {
                id: "anthropic/claude-opus-4-7",
                label: "Claude Opus 4.7",
              },
              { id: "openai/gpt-5.5", label: "GPT-5.5" },
            ],
          },
        }}
        onEvent={onEvent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 4.7/i }));
    fireEvent.change(screen.getByPlaceholderText(/filter models/i), {
      target: { value: "gpt" },
    });
    fireEvent.click(screen.getByText("GPT-5.5").closest("li")!);

    expect(onEvent).toHaveBeenCalledWith(
      "select",
      { sectionId: "models", itemId: "openai/gpt-5.5" },
      "openai/gpt-5.5",
    );
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("emits reasoning and Fast mode changes for supported Codex models", () => {
    const onEvent = vi.fn();
    render(
      <ModelPicker
        component={{ id: "model-picker", type: "model-picker", props: {} }}
        state={{
          model: "openai-codex/gpt-5.5",
          thinkingLevel: "medium",
          codexFastMode: false,
          sidebar: {
            models: [
              {
                id: "openai-codex/gpt-5.5",
                label: "GPT-5.5 Codex",
                thinkingLevels: ["off", "minimal", "medium", "xhigh"],
                codexFastModeSupported: true,
              },
            ],
          },
        }}
        onEvent={onEvent}
      />,
    );

    fireEvent.change(screen.getByLabelText("Reasoning level"), {
      target: { value: "xhigh" },
    });
    fireEvent.click(screen.getByLabelText("Fast"));

    expect(onEvent).toHaveBeenCalledWith(
      "thinking-level",
      { level: "xhigh" },
      "xhigh",
    );
    expect(onEvent).toHaveBeenCalledWith("codex-fast-mode", { enabled: true });
  });

  it("hides reasoning and Fast controls for plain models", () => {
    render(
      <ModelPicker
        component={{ id: "model-picker", type: "model-picker", props: {} }}
        state={{
          model: "anthropic/claude-opus-4-7",
          sidebar: {
            models: [
              { id: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7" },
            ],
          },
        }}
        onEvent={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("Reasoning level")).toBeNull();
    expect(screen.queryByLabelText("Fast")).toBeNull();
  });

  it("supports keyboard selection inside the portal listbox", () => {
    const onEvent = vi.fn();
    render(
      <ModelPicker
        component={{ id: "model-picker", type: "model-picker", props: {} }}
        state={{
          model: "anthropic/claude-opus-4-7",
          sidebar: {
            models: [
              { id: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7" },
              { id: "openai/gpt-5.5", label: "GPT-5.5" },
            ],
          },
        }}
        onEvent={onEvent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 4.7/i }));
    fireEvent.keyDown(screen.getByText("GPT-5.5").closest("li")!, {
      key: "Enter",
    });

    expect(onEvent).toHaveBeenCalledWith(
      "select",
      { sectionId: "models", itemId: "openai/gpt-5.5" },
      "openai/gpt-5.5",
    );
  });
});
