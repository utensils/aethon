// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const authProfileMocks = vi.hoisted(() => ({
  switchAccountForTab: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../auth-profiles", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    switchAccountForTab: authProfileMocks.switchAccountForTab,
  };
});

import { AccountSelector, ModelPicker } from "./variation-components";

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  authProfileMocks.switchAccountForTab.mockClear();
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

  it("clamps stale reasoning state to the active model's supported levels", () => {
    render(
      <ModelPicker
        component={{ id: "model-picker", type: "model-picker", props: {} }}
        state={{
          model: "openai-codex/gpt-5.5",
          thinkingLevel: "xhigh",
          sidebar: {
            models: [
              {
                id: "openai-codex/gpt-5.5",
                label: "GPT-5.5 Codex",
                thinkingLevels: ["off", "medium"],
              },
            ],
          },
        }}
        onEvent={vi.fn()}
      />,
    );

    const select: HTMLSelectElement = screen.getByLabelText("Reasoning level");
    expect(select.value).toBe("off");
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

describe("AccountSelector", () => {
  it("shows the active tab auth profile even when the snapshot map is stale", () => {
    render(
      <AccountSelector
        component={{
          id: "account-selector",
          type: "account-selector",
          props: {},
        }}
        state={{
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              kind: "agent",
              title: "Tab 1",
              cwd: "/repo",
              model: "openai-codex/gpt-5.5",
              waiting: false,
              authProfileId: "openai-codex-secondary",
              messages: [],
            },
          ],
          authProfiles: {
            profiles: [
              {
                id: "openai-codex-primary",
                providerId: "openai-codex",
                label: "Primary",
                kind: "oauth",
              },
              {
                id: "openai-codex-secondary",
                providerId: "openai-codex",
                label: "Secondary",
                kind: "oauth",
              },
            ],
            activeByTab: { "tab-1": "openai-codex-primary" },
            defaultByProvider: { "openai-codex": "openai-codex-primary" },
          },
        }}
        onEvent={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Secondary/i })).toBeTruthy();
  });

  it("switches accounts from the header when a tab only has queued messages", async () => {
    render(
      <AccountSelector
        component={{
          id: "account-selector",
          type: "account-selector",
          props: {},
        }}
        state={{
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              kind: "agent",
              title: "Tab 1",
              cwd: "/repo",
              model: "openai-codex/gpt-5.5",
              waiting: false,
              queueCount: 1,
              queuedMessages: [
                { id: "q1", content: "continue on secondary" },
              ],
              messages: [],
            },
          ],
          authProfiles: {
            profiles: [
              {
                id: "openai-codex-primary",
                providerId: "openai-codex",
                label: "Primary",
                kind: "oauth",
              },
              {
                id: "openai-codex-secondary",
                providerId: "openai-codex",
                label: "Secondary",
                kind: "oauth",
              },
            ],
            activeByTab: { "tab-1": "openai-codex-primary" },
            defaultByProvider: { "openai-codex": "openai-codex-primary" },
          },
        }}
        onEvent={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Primary/i }));
    fireEvent.click(screen.getByText("Secondary").closest("li")!);

    await waitFor(() =>
      expect(authProfileMocks.switchAccountForTab).toHaveBeenCalledWith(
        "tab-1",
        "openai-codex-secondary",
        { cwd: "/repo", model: "openai-codex/gpt-5.5" },
      ),
    );
  });
});
