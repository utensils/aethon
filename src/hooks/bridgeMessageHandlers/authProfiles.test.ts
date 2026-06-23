import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEmptyTab } from "../../types/tab";
import {
  handleAuthProfileChanged,
  handleAuthProfileLoginEvent,
  handleAuthProfiles,
} from "./authProfiles";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

describe("auth profile bridge handlers", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  it("hydrates auth profiles and mirrors active profile ids onto tabs", () => {
    const tab = makeEmptyTab("default", "Tab 1");
    const { ctx, applySetState } = buildHandlerFixture({
      state: {
        tabs: [tab],
        authProfiles: {
          profiles: [],
          defaultByProvider: {},
          providers: [],
          activeByTab: {},
          modal: { open: true },
        },
      },
    });

    handleAuthProfiles(
      {
        type: "auth_profiles",
        authProfiles: {
          profiles: [
            {
              id: "anthropic-work",
              providerId: "anthropic",
              label: "Work",
              kind: "oauth",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          defaultByProvider: {
            anthropic: "anthropic-work",
            invalid: 123,
          },
          providers: [
            {
              id: "anthropic",
              label: "Anthropic",
              kind: "oauth",
              configured: true,
              modelCount: 2,
            },
          ],
          activeByTab: {
            default: "anthropic-work",
            ignored: null,
          },
        },
      },
      ctx,
    );

    expect(applySetState()).toMatchObject({
      tabs: [{ id: "default", authProfileId: "anthropic-work" }],
      authProfiles: {
        profiles: [{ id: "anthropic-work", providerId: "anthropic" }],
        defaultByProvider: { anthropic: "anthropic-work" },
        providers: [{ id: "anthropic", configured: true }],
        activeByTab: { default: "anthropic-work" },
        modal: { open: true },
      },
    });
  });

  it("rejects array maps while hydrating auth profile snapshots", () => {
    const { ctx, applySetState } = buildHandlerFixture({
      state: { tabs: [makeEmptyTab("default", "Tab 1")] },
    });

    handleAuthProfiles(
      {
        type: "auth_profiles",
        authProfiles: {
          profiles: [],
          defaultByProvider: ["anthropic-work"],
          providers: [],
          activeByTab: ["anthropic-work"],
        },
      },
      ctx,
    );

    expect(applySetState()).toMatchObject({
      tabs: [{ id: "default", authProfileId: undefined }],
      authProfiles: {
        defaultByProvider: {},
        activeByTab: {},
      },
    });
  });

  it("records auth profile changes in the tab and snapshot activeByTab map", () => {
    const { ctx, mocks, applySetState } = buildHandlerFixture({
      state: {
        authProfiles: {
          profiles: [],
          defaultByProvider: {},
          providers: [],
          activeByTab: {},
        },
      },
    });

    handleAuthProfileChanged(
      {
        type: "auth_profile_changed",
        tabId: "default",
        profileId: "anthropic-work",
        model: "anthropic/claude-sonnet-4-5",
      },
      ctx,
    );

    expect(mocks.updateTab).toHaveBeenCalledWith("default", expect.any(Function));
    const updater = mocks.updateTab.mock.calls[0]?.[1] as (
      tab: ReturnType<typeof makeEmptyTab>,
    ) => ReturnType<typeof makeEmptyTab>;
    expect(updater(makeEmptyTab("default", "Tab 1"))).toMatchObject({
      authProfileId: "anthropic-work",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(applySetState().authProfiles).toMatchObject({
      activeByTab: { default: "anthropic-work" },
    });
  });

  it("asks an idle target worker tab to apply completed OAuth login", async () => {
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      cwd: "/repo",
      model: "github-copilot/gpt-5.5",
    };
    const { ctx, applySetState } = buildHandlerFixture({
      state: {
        activeTabId: "tab-1",
        tabs: [tab],
        authProfiles: {
          profiles: [],
          defaultByProvider: {},
          providers: [],
          activeByTab: {},
        },
      },
    });

    handleAuthProfileLoginEvent(
      {
        type: "auth_profile_login_event",
        event: {
          type: "complete",
          challengeId: "challenge-1",
          profileId: "copilot-work",
          providerId: "github-copilot",
          targetTabId: "tab-1",
          ok: true,
        },
      },
      ctx,
    );

    await vi.waitFor(() => {
      expect(harness.invoke).toHaveBeenCalledWith("agent_command", {
        payload: JSON.stringify({
          type: "auth_profile_apply",
          tabId: "tab-1",
          profileId: "copilot-work",
          cwd: "/repo",
          model: "github-copilot/gpt-5.5",
        }),
      });
    });
    expect(applySetState().authProfiles).toMatchObject({
      activeByTab: {},
      login: expect.objectContaining({ ok: true }),
    });
  });

  it("does not apply completed OAuth login to a busy target worker tab", () => {
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      cwd: "/repo",
      model: "github-copilot/gpt-5.5",
      waiting: true,
    };
    const { ctx, mocks, applySetState } = buildHandlerFixture({
      state: {
        activeTabId: "tab-1",
        tabs: [tab],
        authProfiles: {
          profiles: [],
          defaultByProvider: {},
          providers: [],
          activeByTab: {},
        },
      },
    });

    handleAuthProfileLoginEvent(
      {
        type: "auth_profile_login_event",
        event: {
          type: "complete",
          challengeId: "challenge-1",
          profileId: "copilot-work",
          providerId: "github-copilot",
          targetTabId: "tab-1",
          ok: true,
        },
      },
      ctx,
    );

    expect(harness.invoke).not.toHaveBeenCalledWith(
      "agent_command",
      expect.objectContaining({
        payload: expect.stringContaining("auth_profile_apply"),
      }),
    );
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Account ready",
        kind: "info",
      }),
    );
    expect(applySetState().authProfiles).toMatchObject({
      activeByTab: {},
      login: expect.objectContaining({ ok: true }),
    });
  });
});
