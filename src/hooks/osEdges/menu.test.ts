import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";
import { subscribeMenu, type MenuDeps } from "./menu";

function deps(overrides: Partial<MenuDeps> = {}): MenuDeps {
  return {
    stateRef: { current: {} },
    newTab: vi.fn(),
    newShellTab: vi.fn(),
    closeTab: vi.fn(),
    activateTabAnywhere: vi.fn(),
    nextTab: vi.fn(),
    toggleTerminal: vi.fn(),
    toggleFilesSidebar: vi.fn(),
    togglePlanMode: vi.fn(),
    openSettings: vi.fn(),
    openScheduledTasks: vi.fn(),
    clearChat: vi.fn(),
    stopPrompt: vi.fn(() => Promise.resolve()),
    checkForUpdates: vi.fn(() => Promise.resolve()),
    appendSystem: vi.fn(),
    ...overrides,
  };
}

describe("subscribeMenu", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  it("routes tray session rows through cross-workspace activation", () => {
    const ctx = deps();
    subscribeMenu(ctx);

    harness.fireEvent("menu", "tray:session:tab-123");

    expect(ctx.activateTabAnywhere).toHaveBeenCalledWith("tab-123");
    expect(ctx.newTab).not.toHaveBeenCalled();
  });

  it("keeps app-menu new_tab routed to newTab", () => {
    const ctx = deps();
    subscribeMenu(ctx);

    harness.fireEvent("menu", "new_tab");

    expect(ctx.newTab).toHaveBeenCalledOnce();
    expect(ctx.activateTabAnywhere).not.toHaveBeenCalled();
  });
});
