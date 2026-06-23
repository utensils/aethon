// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProfilePanel } from "./auth-profile-panel";
import type { A2UIComponent } from "../../types/a2ui";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "execCommand",
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  if (originalExecCommandDescriptor) {
    Object.defineProperty(document, "execCommand", originalExecCommandDescriptor);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
});

function authPanel(): A2UIComponent {
  return {
    id: "auth-profile-panel",
    type: "auth-profile-panel",
  };
}

describe("AuthProfilePanel", () => {
  it("shows OAuth device-code instructions from the provider auth event", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <AuthProfilePanel
        component={authPanel()}
        state={{
          activeTabId: "default",
          tabs: [],
          authProfiles: {
            modal: { open: true },
            profiles: [],
            defaultByProvider: {},
            activeByTab: {},
            providers: [
              {
                id: "github-copilot",
                label: "GitHub Copilot",
                kind: "oauth",
                configured: false,
                modelCount: 1,
              },
            ],
            login: {
              type: "auth",
              challengeId: "challenge-1",
              profileId: "copilot-work",
              providerId: "github-copilot",
              url: "https://github.com/login/device",
              instructions: "Enter code: 1A2B-3C4D",
            },
          },
        }}
        onEvent={vi.fn()}
      />,
    );

    expect(screen.getByText(/Enter code:/)).toBeTruthy();
    const codeInput = screen.getByLabelText("Authentication code");
    expect(codeInput).toBeInstanceOf(HTMLInputElement);
    if (!(codeInput instanceof HTMLInputElement)) {
      throw new Error("Expected authentication code input");
    }
    expect(codeInput.value).toBe("1A2B-3C4D");

    fireEvent.focus(codeInput);
    expect(codeInput.selectionStart).toBe(0);
    expect(codeInput.selectionEnd).toBe("1A2B-3C4D".length);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("1A2B-3C4D"));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("does not show copied when the fallback copy command fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(
      <AuthProfilePanel
        component={authPanel()}
        state={{
          activeTabId: "default",
          tabs: [],
          authProfiles: {
            modal: { open: true },
            profiles: [],
            defaultByProvider: {},
            activeByTab: {},
            providers: [
              {
                id: "github-copilot",
                label: "GitHub Copilot",
                kind: "oauth",
                configured: false,
                modelCount: 1,
              },
            ],
            login: {
              type: "auth",
              challengeId: "challenge-1",
              profileId: "copilot-work",
              providerId: "github-copilot",
              url: "https://github.com/login/device",
              instructions: "Enter code: 1A2B-3C4D",
            },
          },
        }}
        onEvent={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
});
