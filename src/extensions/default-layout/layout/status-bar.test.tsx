// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
});
