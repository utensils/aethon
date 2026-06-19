import { openUrl } from "@tauri-apps/plugin-opener";
import {
  sendAuthProfileCommand,
  type AuthProfileLoginEvent,
  type AuthProfileMeta,
  type AuthProfileProvider,
  type AuthProfilesSnapshot,
} from "../../auth-profiles";
import type { Tab } from "../../types/tab";
import type { BridgeMessageHandler } from "./types";

type AuthProfilesState = AuthProfilesSnapshot & {
  modal?: { open?: boolean };
  login?: AuthProfileLoginEvent;
  usage?: Record<string, unknown>;
};

function snapshotFrom(value: unknown): AuthProfilesSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  return {
    profiles: Array.isArray(rec.profiles)
      ? rec.profiles.filter(isProfileMeta)
      : [],
    defaultByProvider: stringRecord(rec.defaultByProvider),
    providers: Array.isArray(rec.providers)
      ? rec.providers.filter(isProfileProvider)
      : [],
    activeByTab: stringRecord(rec.activeByTab),
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

function isProfileMeta(value: unknown): value is AuthProfileMeta {
  if (!value || typeof value !== "object") return false;
  const rec = value as Partial<AuthProfileMeta>;
  return (
    typeof rec.id === "string" &&
    typeof rec.providerId === "string" &&
    typeof rec.label === "string" &&
    (rec.kind === "oauth" || rec.kind === "api_key") &&
    typeof rec.createdAt === "number" &&
    typeof rec.updatedAt === "number"
  );
}

function isProfileProvider(value: unknown): value is AuthProfileProvider {
  if (!value || typeof value !== "object") return false;
  const rec = value as Partial<AuthProfileProvider>;
  return (
    typeof rec.id === "string" &&
    typeof rec.label === "string" &&
    (rec.kind === "oauth" || rec.kind === "api_key") &&
    typeof rec.configured === "boolean" &&
    typeof rec.modelCount === "number"
  );
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
        // Preserve the per-profile usage cache — it arrives via separate
        // `auth_profile_usage` messages and must survive snapshot refreshes.
        usage: current.usage,
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
  // Relay the selection to the global bridge so its tabAuthProfileIds stays
  // in sync with worker-side switches (e.g. usage-limit auto-switch). Without
  // this, a later global auth_profiles snapshot would revert this tab to the
  // stale account. The record handler is emit-free, so this can't loop.
  void sendAuthProfileCommand({
    type: "auth_profile_record",
    tabId,
    profileId,
  }).catch(() => {
    /* bridge restart / reload — best-effort sync, ignore */
  });
};
