import { describe, expect, it } from "vitest";
import { handleTerminalPanel, handleShareModeCycle } from "./terminal";
import { buildRouteFixture } from "./testFixtures";
import type { Tab } from "../types/tab";

describe("handleTerminalPanel", () => {
  it("select-sub-tab routes to setActiveSubTab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleTerminalPanel(
      {
        component: { id: "tp", type: "terminal-panel" },
        eventType: "select-sub-tab",
        data: { subTabId: "shell-1" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.setActiveSubTab).toHaveBeenCalledWith("shell-1");
  });

  it("close-sub-tab on a shell sub-tab closes that tab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleTerminalPanel(
      {
        component: { id: "tp", type: "terminal-panel" },
        eventType: "close-sub-tab",
        data: { subTabId: "shell-2" },
      },
      ctx,
    );
    expect(mocks.closeTab).toHaveBeenCalledWith("shell-2");
  });

  it("close-sub-tab on agent-bash is a no-op", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleTerminalPanel(
      {
        component: { id: "tp", type: "terminal-panel" },
        eventType: "close-sub-tab",
        data: { subTabId: "agent-bash" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it("new-shell-sub-tab spawns a shell", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleTerminalPanel(
      {
        component: { id: "tp", type: "terminal-panel" },
        eventType: "new-shell-sub-tab",
      },
      ctx,
    );
    expect(mocks.newShellTab).toHaveBeenCalledTimes(1);
  });

  it("resize stores the terminal panel height in state", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: { terminalPanel: { activeSubId: "agent-bash" } },
    });
    const handled = await handleTerminalPanel(
      {
        component: { id: "tp", type: "terminal-panel" },
        eventType: "resize",
        data: { height: 360 },
      },
      ctx,
    );
    expect(handled).toBe(true);
    const next = applySetState();
    expect((next.terminalPanel as { height?: number }).height).toBe(360);
  });

  it("resize clamps height and resize-end avoids legacy one-off writes", async () => {
    const { ctx, mocks, applySetState } = buildRouteFixture({
      state: { terminalPanel: { height: 240 } },
    });
    await handleTerminalPanel(
      {
        component: { id: "tp", type: "terminal-panel" },
        eventType: "resize",
        data: { height: 9999 },
      },
      ctx,
    );
    const next = applySetState();
    expect((next.terminalPanel as { height?: number }).height).toBe(720);

    await handleTerminalPanel(
      {
        component: { id: "tp", type: "terminal-panel" },
        eventType: "resize-end",
      },
      ctx,
    );
    expect(mocks.writeState).not.toHaveBeenCalled();
  });
});

describe("handleShareModeCycle", () => {
  function shellTab(id: string, mode: Tab["shell"]): Tab {
    return {
      id,
      kind: "shell",
      shell: mode,
      label: id,
      messages: [],
      draft: "",
    } as unknown as Tab;
  }

  it("cycles share mode and persists via shell_set_share_mode", async () => {
    const tab = shellTab("shell-7", {
      cwd: "/tmp",
      command: "bash",
      args: [],
      shareMode: "private",
      shellState: "running",
    });
    const { ctx, mocks } = buildRouteFixture({
      state: { tabs: [tab] },
    });
    const handled = await handleShareModeCycle(
      {
        component: { id: "shell-canvas", type: "shell-canvas" },
        eventType: "cycle-share-mode",
        data: { tabId: "shell-7" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    // Cycle order: private → read.
    expect(mocks.invoke).toHaveBeenCalledWith("shell_set_share_mode", {
      tabId: "shell-7",
      mode: "read",
    });
  });

  it("returns false for the wrong eventType / componentType", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleShareModeCycle(
      {
        component: { id: "shell-canvas", type: "shell-canvas" },
        eventType: "click",
        data: { tabId: "x" },
      },
      ctx,
    );
    expect(handled).toBe(false);
  });

  it("no-ops when tabId is missing", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleShareModeCycle(
      {
        component: { id: "share-mode-badge", type: "share-mode-badge" },
        eventType: "cycle-share-mode",
        data: {},
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
