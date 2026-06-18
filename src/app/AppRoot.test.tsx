// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppRoot } from "./AppRoot";
import { ExtensionRegistry } from "../extensions/ExtensionRegistry";
import { Layout } from "../extensions/default-layout/layout";
import type { A2UIPayload } from "../types/a2ui";

afterEach(() => cleanup());

const noop = () => {};

function registry() {
  const reg = new ExtensionRegistry();
  reg.register({ name: "test-layout", components: { layout: Layout } });
  return reg;
}

function layoutPayload(): A2UIPayload {
  return {
    components: [
      {
        id: "root-layout",
        type: "layout",
        props: {
          columns: "120px minmax(0, 1fr)",
          rows: "38px minmax(0, 1fr)",
          areas: ["sidebar header", "sidebar canvas"],
        },
        children: [
          {
            id: "sidebar",
            type: "container",
            props: { area: "sidebar", className: "test-sidebar" },
            children: [{ id: "sidebar-text", type: "text", props: { text: "Sidebar" } }],
          },
          {
            id: "header",
            type: "container",
            props: { area: "header", className: "test-header" },
            children: [{ id: "header-text", type: "text", props: { text: "Header" } }],
          },
          {
            id: "canvas",
            type: "container",
            props: { area: "canvas", className: "test-canvas" },
            children: [{ id: "canvas-text", type: "text", props: { text: "Workspace" } }],
          },
        ],
      },
    ],
  };
}

describe("AppRoot workspace startup overlay", () => {
  it("mounts running workspace startup inside the canvas cell after chrome is ready", async () => {
    const { container } = render(
      <AppRoot
        registry={registry()}
        layout={layoutPayload()}
        renderState={{}}
        setState={noop}
        onEvent={noop}
        activeTabId="default"
        notificationsOpen={false}
        paletteOpen={false}
        settingsOpen={false}
        searchOpen={false}
        authProfilesOpen={false}
        chromeReady
        startupLogoUrl="/logo.svg"
        workspaceStartup={{
          output: "",
          entry: {
            root: "/repo",
            fingerprint: "abc",
            state: "running",
            approved: true,
            commands: [],
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(
        screen
          .getByRole("status")
          .classList.contains("ae-startup-curtain--workspace"),
      ).toBe(true);
    });

    const startup = screen.getByRole("status");
    const canvasCell = container.querySelector<HTMLElement>(
      '.a2ui-layout-cell[data-area="canvas"]',
    );
    const sidebarCell = container.querySelector<HTMLElement>(
      '.a2ui-layout-cell[data-area="sidebar"]',
    );

    expect(canvasCell).not.toBeNull();
    expect(canvasCell?.contains(startup)).toBe(true);
    expect(sidebarCell?.contains(startup)).toBe(false);
    expect(startup.parentElement).toBe(canvasCell);
  });
});
