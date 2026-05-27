import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AuthProfileLoginEvent,
  AuthProfilesSnapshot,
} from "../../auth-profiles";
import type { Tab } from "../../types/tab";
import type { BridgeMessageHandler } from "./types";

type AuthProfilesState = AuthProfilesSnapshot & {
  modal?: { open?: boolean };
  login?: AuthProfileLoginEvent;
};

function snapshotFrom(value: unknown): AuthProfilesSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Partial<AuthProfilesSnapshot>;
  return {
    profiles: Array.isArray(rec.profiles) ? rec.profiles : [],
    defaultByProvider:
      rec.defaultByProvider && typeof rec.defaultByProvider === "object"
        ? rec.defaultByProvider
        : {},
    providers: Array.isArray(rec.providers) ? rec.providers : [],
    activeByTab:
      rec.activeByTab && typeof rec.activeByTab === "object"
        ? rec.activeByTab
        : {},
  };
}

export const handleAuthProfiles: BridgeMessageHandler = (message, ctx) => {
  const snapshot = snapshotFrom(message.authProfiles);
  if (!snapshot) return;
  ctx.setState((prev) => {
    const current = (prev.authProfiles as AuthProfilesState | undefined) ?? {
      profiles: [],
      defaultByProvider: {},
      providers: [],
      activeByTab: {},
    };
    const tabs = ((prev.tabs as Tab[] | undefined) ?? []).map((tab) => ({
      ...tab,
      authProfileId: snapshot.activeByTab[tab.id],
    }));
    return {
      ...prev,
      tabs,
      authProfiles: {
        ...snapshot,
        modal: current.modal,
        login: current.login,
      },
    };
  });
};

export const handleAuthProfileLoginEvent: BridgeMessageHandler = (
  message,
  ctx,
) => {
  const event = message.event as AuthProfileLoginEvent | undefined;
  if (!event?.type || !event.challengeId) return;
  if (event.type === "auth" && event.url) {
    openUrl(event.url).catch((err: unknown) => {
      ctx.pushNotification({
        title: "Open login URL failed",
        message: String(err),
        kind: "error",
      });
    });
  }
  if (event.type === "complete") {
    ctx.pushNotification({
      title: event.ok ? "Account added" : "Login failed",
      message: event.error,
      kind: event.ok ? "success" : "error",
    });
  }
  ctx.setState((prev) => {
    const current = (prev.authProfiles as AuthProfilesState | undefined) ?? {};
    return {
      ...prev,
      authProfiles: {
        profiles: [],
        defaultByProvider: {},
        providers: [],
        activeByTab: {},
        ...current,
        login: event,
      },
    };
  });
};

export const handleAuthProfileChanged: BridgeMessageHandler = (message, ctx) => {
  const tabId = typeof message.tabId === "string" ? message.tabId : undefined;
  const profileId =
    typeof message.profileId === "string" ? message.profileId : undefined;
  const model = typeof message.model === "string" ? message.model : undefined;
  if (!tabId || !profileId) return;
  ctx.updateTab(tabId, (tab) => ({
    ...tab,
    authProfileId: profileId,
    ...(model ? { model } : {}),
  }));
  ctx.setState((prev) => ({
    ...prev,
    authProfiles: {
      ...(prev.authProfiles ?? {
          profiles: [],
          defaultByProvider: {},
          providers: [],
          activeByTab: {},
        }),
      activeByTab: {
        ...((prev.authProfiles as AuthProfilesState | undefined)
          ?.activeByTab ?? {}),
        [tabId]: profileId,
      },
    },
  }));
};
