// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import NativeCanvasWindowApp from "./NativeCanvasWindowApp";
import { clearTauriMocks, installTauriMocks } from "./test/tauriMocks";
import type { NativeCanvasWindowRecord } from "./nativeWindows";

const baseRecord: NativeCanvasWindowRecord = {
  id: "Workpad",
  label: "aethon-canvas-Workpad",
  kind: "canvas",
  title: "Workpad",
  tabId: "tab-1",
  restoreOnLaunch: true,
  components: [
    {
      id: "draft",
      type: "text-input",
      props: { value: { $ref: "/draft" }, placeholder: "Draft" },
    },
  ],
  state: { draft: "" },
};

describe("NativeCanvasWindowApp", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
    class ResizeObserverStub {
      observe = vi.fn();
      disconnect = vi.fn();
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverStub,
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: window.ResizeObserver,
    });
  });

  afterEach(() => {
    clearTauriMocks();
    vi.useRealTimers();
  });

  it("hydrates a canvas record and persists local state without booting the main bridge", async () => {
    const saved: NativeCanvasWindowRecord[] = [];
    harness.invoke.mockImplementation((command, args) => {
      if (command === "native_window_get_canvas") {
        return Promise.resolve(baseRecord);
      }
      if (command === "native_window_save_canvas") {
        saved.push(args.record);
        return Promise.resolve(args.record);
      }
      return Promise.resolve(undefined);
    });

    render(<NativeCanvasWindowApp id="Workpad" />);

    const input = await screen.findByPlaceholderText("Draft");
    fireEvent.change(input, { target: { value: "hello" } });

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({
      id: "Workpad",
      state: { draft: "hello" },
    });
    expect(harness.invoke).not.toHaveBeenCalledWith("start_agent");
    expect(harness.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({ type: "report" }),
    });
  });

  it("ignores shell output for windows that do not own the shell tab", async () => {
    const saved: NativeCanvasWindowRecord[] = [];
    harness.invoke.mockImplementation((command, args) => {
      if (command === "native_window_get_canvas")
        return Promise.resolve(baseRecord);
      if (command === "native_window_save_canvas") {
        saved.push(args.record);
        return Promise.resolve(args.record);
      }
      return Promise.resolve(undefined);
    });

    render(<NativeCanvasWindowApp id="Workpad" />);
    await screen.findByPlaceholderText("Draft");

    act(() => {
      harness.fireEvent("shell-output", {
        tabId: "shell-elsewhere",
        content: "hi",
      });
    });
    await Promise.resolve();

    expect(saved).toHaveLength(0);
  });

  it("routes shell-canvas share-mode badge clicks inside native windows", async () => {
    const saved: NativeCanvasWindowRecord[] = [];
    harness.invoke.mockImplementation((command, args) => {
      if (command === "native_window_get_canvas") {
        return Promise.resolve({
          ...baseRecord,
          components: [
            {
              id: "terminal",
              type: "shell-canvas",
              props: { tabId: "shell-1" },
            },
          ],
          state: {
            tabs: [
              {
                id: "shell-1",
                label: "Shell 1",
                kind: "shell",
                terminalBuffer: "",
                shell: {
                  cwd: "/repo",
                  command: "zsh",
                  args: [],
                  shareMode: "private",
                  shellState: "running",
                },
              },
            ],
          },
        });
      }
      if (command === "shell_set_share_mode") return Promise.resolve("read");
      if (command === "native_window_save_canvas") {
        saved.push(args.record);
        return Promise.resolve(args.record);
      }
      return Promise.resolve(undefined);
    });

    render(<NativeCanvasWindowApp id="Workpad" />);

    const badge = await screen.findByRole("button", {
      name: /Share mode: private/i,
    });
    fireEvent.click(badge);

    await waitFor(() =>
      expect(harness.invoke).toHaveBeenCalledWith("shell_set_share_mode", {
        tabId: "shell-1",
        mode: "read",
      }),
    );
    await waitFor(() => expect(saved.length).toBeGreaterThan(0));
    expect(saved.at(-1)?.state).toMatchObject({
      tabs: [
        expect.objectContaining({
          id: "shell-1",
          shell: expect.objectContaining({ shareMode: "read" }),
        }),
      ],
    });
  });

  it("hydrates extension templates from bridge replay events", async () => {
    harness.invoke.mockImplementation((command) => {
      if (command === "native_window_get_canvas") {
        return Promise.resolve({
          ...baseRecord,
          components: [{ id: "custom", type: "window-card" }],
        });
      }
      return Promise.resolve(undefined);
    });

    render(<NativeCanvasWindowApp id="Workpad" />);
    await waitFor(() =>
      expect(harness.listen).toHaveBeenCalledWith(
        "agent-response",
        expect.any(Function),
      ),
    );
    act(() => {
      harness.fireEvent(
        "agent-response",
        JSON.stringify({
          type: "ready",
          extensionComponents: {
            "window-card": {
              id: "window-card-root",
              type: "text",
              props: { content: "Hydrated window card" },
            },
          },
          extensionThemes: [],
          extensionFrontendModules: [],
          extensionHighlightGrammars: [],
        }),
      );
    });

    expect(await screen.findByText("Hydrated window card")).toBeTruthy();
  });
});
