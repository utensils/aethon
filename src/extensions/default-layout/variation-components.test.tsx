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
  setDefaultAccount: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../auth-profiles", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    switchAccountForTab: authProfileMocks.switchAccountForTab,
    setDefaultAccount: authProfileMocks.setDefaultAccount,
  };
});

import {
  AccountSelector,
  DropdownPickerCore,
  ModelPicker,
  VcsStatus,
} from "./variation-components";

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
  authProfileMocks.setDefaultAccount.mockClear();
});

describe("ModelPicker", () => {
  it("keeps the portal dropdown inside the viewport on narrow screens", () => {
    vi.stubGlobal("innerWidth", 220);
    vi.stubGlobal("innerHeight", 640);
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 168,
        y: 20,
        top: 20,
        left: 168,
        bottom: 54,
        right: 216,
        width: 48,
        height: 34,
        toJSON: () => ({}),
      });

    render(
      <DropdownPickerCore
        buttonLabel="GPT-5.5"
        align="right"
        sections={[
          {
            id: "models",
            title: "models",
            items: [{ id: "openai/gpt-5.5", label: "GPT-5.5" }],
          },
        ]}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /GPT-5.5/i }));

    const panel = screen.getByRole("listbox");
    expect(panel.style.left).toBe("8px");
    expect(panel.style.width).toBe("204px");
    expect(panel.style.right).toBe("");
    rectSpy.mockRestore();
  });

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

describe("VcsStatus", () => {
  it("opens all changed files from the changed-files chip", () => {
    const onEvent = vi.fn();
    render(
      <VcsStatus
        component={{ id: "vcs-status", type: "vcs-status", props: {} }}
        state={{
          vcs: {
            root: "/repo",
            branch: "main",
            ahead: 0,
            behind: 0,
            loading: false,
            changes: {
              total: 2,
              modified: 2,
              added: 0,
              deleted: 0,
              untracked: 0,
              renamed: 0,
              copied: 0,
              conflicted: 0,
              insertions: 10,
              deletions: 2,
              files: [
                { path: "src/App.tsx", status: "modified" },
                { path: "agent/main.ts", status: "modified" },
              ],
            },
          },
        }}
        onEvent={onEvent}
      />,
    );

    const button = screen.getByRole("button", { name: /2 changed/i });
    expect(button.getAttribute("title")).toBe(
      "2 changed files — open all in editor",
    );
    fireEvent.click(button);

    expect(onEvent).toHaveBeenCalledWith("file-tree-open-many", {
      files: [
        { filePath: "/repo/src/App.tsx", rootPath: "/repo" },
        { filePath: "/repo/agent/main.ts", rootPath: "/repo" },
      ],
    });
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

  // The overview has no live agent session. Picking an account there must set
  // the provider DEFAULT (which new tasks inherit), not rebind a phantom
  // "default" tab — otherwise the header shows the unchanged provider default
  // and the pick appears to do nothing.
  const overviewState = {
    activeTabId: "__overview__",
    tabs: [],
    defaultModel: "openai-codex/gpt-5.5",
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
      activeByTab: {},
      defaultByProvider: { "openai-codex": "openai-codex-secondary" },
    },
  };

  it("shows the provider default on the overview (no active agent tab)", () => {
    render(
      <AccountSelector
        component={{ id: "account-selector", type: "account-selector", props: {} }}
        state={overviewState}
        onEvent={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Secondary/i })).toBeTruthy();
  });

  it("sets the provider default (not a tab switch) when picking on the overview", async () => {
    render(
      <AccountSelector
        component={{ id: "account-selector", type: "account-selector", props: {} }}
        state={overviewState}
        onEvent={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Secondary/i }));
    fireEvent.click(screen.getByText("Primary").closest("li")!);

    await waitFor(() =>
      expect(authProfileMocks.setDefaultAccount).toHaveBeenCalledWith(
        "openai-codex-primary",
      ),
    );
    expect(authProfileMocks.switchAccountForTab).not.toHaveBeenCalled();
  });

  // A new tab launched from the overview resolves its model via
  // modelForNewProjectTab, which prefers the active project's remembered model
  // over the pi default. The selector must scope to *that* provider — not the
  // pi default's — or it would show/set the wrong account.
  it("scopes the overview selector to the project's remembered model provider", () => {
    render(
      <AccountSelector
        component={{
          id: "account-selector",
          type: "account-selector",
          props: {},
        }}
        state={{
          activeTabId: "__overview__",
          activeProjectId: "proj-a",
          tabs: [],
          // Header default empty → per-project memory wins over the pi default.
          defaultModel: "",
          piDefaultModel: "openai-codex/gpt-5.5",
          projectModels: { "proj-a": "anthropic/claude-opus" },
          authProfiles: {
            profiles: [
              {
                id: "openai-codex-primary",
                providerId: "openai-codex",
                label: "Primary",
                kind: "oauth",
              },
              {
                id: "anthropic-main",
                providerId: "anthropic",
                label: "Anthropic",
                kind: "oauth",
              },
            ],
            activeByTab: {},
            defaultByProvider: {
              "openai-codex": "openai-codex-primary",
              anthropic: "anthropic-main",
            },
          },
        }}
        onEvent={vi.fn()}
      />,
    );

    // Scoped to anthropic (the project's remembered model) — shows the
    // Anthropic account and offers no OpenAI account.
    expect(screen.getByRole("button", { name: /Anthropic/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Anthropic/i }));
    expect(screen.queryByText("Primary")).toBeNull();
  });
});
