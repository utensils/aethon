import { describe, expect, it } from "vitest";
import { makeEmptyTab } from "../../types/tab";
import {
  handleAuthProfileChanged,
  handleAuthProfiles,
} from "./authProfiles";
import { buildHandlerFixture } from "./testFixtures";

describe("auth profile bridge handlers", () => {
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
});
