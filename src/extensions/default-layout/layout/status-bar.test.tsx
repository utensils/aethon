// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { A2UIComponent } from "../../../types/a2ui";
import { StatusBar } from "./status-bar";

afterEach(() => cleanup());

function statusBarComponent(): A2UIComponent {
  return {
    id: "status-bar",
    type: "status-bar",
    props: {
      left: { $ref: "/status" },
      center: { $ref: "/connection" },
      right: { $ref: "/model" },
      context: { $ref: "/contextUsage" },
    },
  };
}

function renderStatusBar(state: Record<string, unknown>) {
  render(
    <StatusBar
      component={statusBarComponent()}
      state={state}
      onEvent={vi.fn()}
    />,
  );
}

describe("StatusBar agent state", () => {
  afterEach(() => vi.useRealTimers());

  it("moves idle agent status to the center and keeps connection on the left", () => {
    renderStatusBar({
      status: "ready",
      connection: "connected",
      model: "anthropic/claude",
    });

    const footer = screen.getByText("idle").closest(".a2ui-status-bar");
    expect(footer?.querySelector(".a2ui-status-left")?.textContent).toBe(
      "connected",
    );
    expect(footer?.querySelector(".a2ui-status-center")?.textContent).toBe(
      "idle",
    );
  });

  it("shows the full live activity label where connection used to render", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    renderStatusBar({
      status: "Working",
      connection: "connected",
      model: "anthropic/claude",
      activeTabId: "tab-1",
      agentActivityByTab: {
        "tab-1": {
          label: "Running checks",
          detail: "Waiting for results",
          startedAt: 9_000,
          updatedAt: 10_000,
        },
      },
    });

    act(() => vi.runOnlyPendingTimers());

    const footer = screen
      .getByText("Running checks")
      .closest(".a2ui-status-bar");
    expect(footer?.querySelector(".a2ui-status-left")?.textContent).toBe(
      "connected",
    );
    expect(footer?.querySelector(".a2ui-status-center")?.textContent).toBe(
      "Running checksWaiting for results",
    );
  });

  it("uses a generic center status while waiting before activity arrives", () => {
    renderStatusBar({
      status: "thinking…",
      connection: "connected",
      model: "anthropic/claude",
      waiting: true,
    });

    expect(screen.getByText("Thinking through next step")).toBeTruthy();
    expect(screen.getByText("Waiting for the next update")).toBeTruthy();
    expect(screen.getByText("connected")).toBeTruthy();
  });
});

describe("StatusBar context meter", () => {
  it("renders current context and next auto-compaction threshold", () => {
    renderStatusBar({
      status: "ready",
      connection: "connected",
      model: "anthropic/claude",
      contextUsage: {
        model: "anthropic/claude",
        status: "known",
        tokens: 13_073,
        contextWindow: 262_144,
        percent: 4.98,
        autoCompactEnabled: true,
        reserveTokens: 16_384,
        compactAtTokens: 245_760,
        tokensUntilCompact: 232_687,
      },
    });

    expect(screen.getByLabelText("Context 5%")).toBeTruthy();
    expect(screen.getByText("ctx 5%")).toBeTruthy();
    expect(screen.getByText("13k/262k")).toBeTruthy();
    expect(screen.getByText("auto @246k")).toBeTruthy();
  });

  it("shows unknown usage after compaction without losing the threshold", () => {
    renderStatusBar({
      status: "ready",
      connection: "connected",
      model: "anthropic/claude",
      contextUsage: {
        model: "anthropic/claude",
        status: "unknown",
        tokens: null,
        contextWindow: 200_000,
        percent: null,
        autoCompactEnabled: true,
        reserveTokens: 16_384,
        compactAtTokens: 183_616,
        tokensUntilCompact: null,
      },
    });

    expect(screen.getByLabelText("Context ?")).toBeTruthy();
    expect(screen.getByText("?/200k")).toBeTruthy();
    expect(screen.getByText("auto @184k")).toBeTruthy();
  });

  it("renders live tool-output saturation as an estimate, not authoritative 100%", () => {
    renderStatusBar({
      status: "ready",
      connection: "connected",
      model: "anthropic/claude",
      contextUsage: {
        model: "anthropic/claude",
        status: "known",
        tokens: 199_999,
        contextWindow: 272_000,
        percent: 73.5,
        estimatedTokens: 280_000,
        estimatedPercent: 102.9,
        transientTokens: 80_001,
        autoCompactEnabled: true,
        reserveTokens: 16_384,
        compactAtTokens: 255_616,
        tokensUntilCompact: 55_617,
        estimatedTokensUntilCompact: 0,
        saturatedByEstimate: true,
      },
    });

    expect(screen.getByText("ctx 74%")).toBeTruthy();
    expect(screen.getByText("200k/272k")).toBeTruthy();
    expect(screen.getByText("est 272k+")).toBeTruthy();
    expect(screen.getByText("pending turn")).toBeTruthy();
    const chip = screen.getByLabelText(
      "Context 74%, tool-output estimate pending compaction",
    );
    expect(chip.getAttribute("title")).toContain(
      "Live estimate including current turn/tool output",
    );
    expect(chip.getAttribute("title")).toContain(
      "compaction is pending the current turn",
    );
  });

  it("surfaces a distinct FULL state when the window is saturated (Ollama truncating)", () => {
    renderStatusBar({
      status: "ready",
      connection: "connected",
      model: "ollama-localhost/qwen3.6:35b-a3b-coding-nvfp4",
      contextUsage: {
        model: "ollama-localhost/qwen3.6:35b-a3b-coding-nvfp4",
        status: "known",
        tokens: 262_144,
        contextWindow: 262_144,
        percent: 100,
        autoCompactEnabled: true,
        reserveTokens: 16_384,
        compactAtTokens: 245_760,
        tokensUntilCompact: 0,
        saturated: true,
      },
    });

    // Reads "FULL", not a calm "100%".
    expect(screen.getByText("ctx FULL")).toBeTruthy();
    const chip = screen.getByLabelText("Context full, truncating");
    expect(chip).toBeTruthy();
    expect(chip.className).toContain("is-saturated");
    expect(chip.className).toContain("is-danger");
    expect(chip.getAttribute("title")).toContain("truncated");
  });
});
