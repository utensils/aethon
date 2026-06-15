// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ShellCanvas } from "./canvas";
import { applyUiScale } from "../../../utils/viewport";

interface MockTerminal {
  options: { fontSize?: number };
  cols: number;
  rows: number;
  open: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

interface MockFitAddon {
  term?: MockTerminal;
  fit: ReturnType<typeof vi.fn>;
  __attach: (term: MockTerminal) => void;
}

const xtermMocks = vi.hoisted(() => ({
  terminals: [] as MockTerminal[],
  fits: [] as MockFitAddon[],
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function (options: { fontSize?: number }) {
    const term: MockTerminal = {
      options: { ...options },
      cols: 80,
      rows: 24,
      open: vi.fn(),
      loadAddon: vi.fn((addon: { __attach?: (term: MockTerminal) => void }) => {
        addon.__attach?.(term);
      }),
      write: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      refresh: vi.fn(),
      dispose: vi.fn(),
    };
    xtermMocks.terminals.push(term);
    return term;
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function () {
    const fit: MockFitAddon = {
      fit: vi.fn(() => {
        const fontSize = fit.term?.options.fontSize ?? 13;
        if (fit.term) {
          fit.term.cols = Math.floor(960 / fontSize);
          fit.term.rows = Math.floor(260 / fontSize);
        }
      }),
      __attach: (term: MockTerminal) => {
        fit.term = term;
      },
    };
    xtermMocks.fits.push(fit);
    return fit;
  }),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function () {
    return {
      onContextLoss: vi.fn(),
      dispose: vi.fn(),
    };
  }),
}));

vi.mock("../../../components/A2UIRenderer", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    RegistryComponent: () => <span data-testid="share-mode-badge" />,
  };
});

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  xtermMocks.terminals.length = 0;
  xtermMocks.fits.length = 0;
  vi.mocked(invoke).mockClear();
  document.documentElement.style.removeProperty("--app-ui-scale");
  document.documentElement.style.zoom = "";
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ShellCanvas zoom synchronization", () => {
  it("refits xterm and resizes the PTY when app zoom changes", async () => {
    const state = {
      tabs: [
        {
          id: "shell-1",
          kind: "shell",
          shell: { cwd: "/repo", command: "zsh", shareMode: "private" },
        },
      ],
    };

    const { container } = render(
      <ShellCanvas
        component={{
          id: "shell-canvas",
          type: "shell-canvas",
          props: { tabId: "shell-1", fontSize: 13 },
        }}
        state={state}
        onEvent={vi.fn()}
      />,
    );

    const term = xtermMocks.terminals[0];
    const fit = xtermMocks.fits[0];
    const mount = container.querySelector<HTMLElement>(".ae-shell-canvas-term");

    applyUiScale(1.5);

    await waitFor(() => expect(term.options.fontSize).toBeCloseTo(19.5));
    expect(Number(mount?.style.zoom)).toBeCloseTo(1 / 1.5);
    expect(fit.fit.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(term.refresh).toHaveBeenCalledWith(0, expect.any(Number));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("shell_resize", {
        tabId: "shell-1",
        cols: Math.floor(960 / 19.5),
        rows: Math.floor(260 / 19.5),
      }),
    );
  });
});
