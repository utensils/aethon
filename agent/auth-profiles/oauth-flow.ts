import { randomUUID } from "node:crypto";
import type { AethonAgentState } from "../state";
import type { DispatcherDeps, InboundMessage } from "../dispatcherTypes";
import { emitGlobalReady } from "../dispatcherTypes";
import { createProfileMeta } from "./store";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { ensureProfileServices, servicesForProfile } from "./services-cache";
import {
  findProfile,
  removeProfile,
  saveAuthProfiles,
  stringField,
} from "./profile-state";
import { emitAuthProfiles } from "./snapshot";
import {
  refreshTabsAfterAuthChange,
  targetTabIdFromMessage,
} from "./tab-account-binding";

interface PendingOAuth {
  profileId: string;
  providerId: string;
  targetTabId?: string;
  controller: AbortController;
  isReauth: boolean;
  resolvePrompt?: (value: string) => void;
}

const pendingOAuth = new Map<string, PendingOAuth>();

export async function handleOAuthStart(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const providerId = stringField(msg.providerId);
  if (!providerId)
    throw new Error("auth_profile_login_start: providerId required");
  const requestedProfileId = stringField(msg.profileId);
  const existing = requestedProfileId
    ? findProfile(state, requestedProfileId)
    : undefined;
  if (requestedProfileId && !existing) {
    throw new Error("auth_profile_login_start: unknown profileId");
  }
  if (existing && existing.providerId !== providerId) {
    throw new Error("auth_profile_login_start: providerId mismatch");
  }
  if (existing && existing.kind !== "oauth") {
    throw new Error("auth_profile_login_start: profile is not oauth");
  }
  const isReauth = Boolean(existing);
  const targetTabId = targetTabIdFromMessage(msg);
  const meta =
    existing ??
    createProfileMeta(state.authProfiles, {
      providerId,
      label: stringField(msg.label) || providerId,
      kind: "oauth",
    });
  if (!existing) {
    state.authProfiles = {
      ...state.authProfiles,
      profiles: [...state.authProfiles.profiles, meta],
    };
    saveAuthProfiles(state);
  }
  // Abort any lingering OAuth flow for this provider — pi-ai's callback
  // server binds to a hardcoded port per provider, so a stale server from
  // a previous login blocks the new flow's state from registering.
  for (const [oldId, oldPending] of pendingOAuth) {
    if (oldPending.providerId === providerId) {
      oldPending.controller.abort();
      pendingOAuth.delete(oldId);
    }
  }

  const services = await ensureProfileServices(state, meta.id);
  const challengeId = randomUUID();
  const pending: PendingOAuth = {
    profileId: meta.id,
    providerId,
    targetTabId,
    controller: new AbortController(),
    isReauth,
  };
  pendingOAuth.set(challengeId, pending);
  deps.send({
    type: "auth_profile_login_event",
    event: { type: "started", challengeId, profileId: meta.id, providerId },
  });
  const sendProgress = (message: string): void => {
    deps.send({
      type: "auth_profile_login_event",
      event: {
        type: "progress",
        challengeId,
        profileId: meta.id,
        providerId,
        message,
      },
    });
  };
  // pi's AuthInteraction: `notify` carries the auth URL / device code /
  // progress, `prompt` asks for text (manual code, select, secret). The
  // wire events sent to the frontend are unchanged from the pre-0.80 shape.
  const notify = (event: AuthEvent): void => {
    switch (event.type) {
      case "auth_url":
        deps.send({
          type: "auth_profile_login_event",
          event: {
            type: "auth",
            challengeId,
            profileId: meta.id,
            providerId,
            url: event.url,
            instructions: event.instructions,
          },
        });
        return;
      case "device_code":
        deps.send({
          type: "auth_profile_login_event",
          event: {
            type: "auth",
            challengeId,
            profileId: meta.id,
            providerId,
            url: event.verificationUri,
            instructions: `Enter code ${event.userCode} to authorize.`,
          },
        });
        return;
      case "info":
      case "progress":
        sendProgress(event.message);
        return;
    }
  };
  const prompt = (request: AuthPrompt): Promise<string> =>
    new Promise<string>((resolve) => {
      pending.resolvePrompt = resolve;
      const message =
        request.type === "select"
          ? `${request.message}\n${request.options
              .map((option) => `${option.id} — ${option.label}`)
              .join("\n")}`
          : request.type === "manual_code"
            ? request.message || "Paste the authorization code or callback URL."
            : request.message;
      deps.send({
        type: "auth_profile_login_event",
        event: {
          type: "prompt",
          challengeId,
          profileId: meta.id,
          providerId,
          message,
          placeholder:
            request.type === "select" ? undefined : request.placeholder,
          allowEmpty: false,
        },
      });
    });
  void services.modelRuntime
    .login(providerId, "oauth", {
      signal: pending.controller.signal,
      notify,
      prompt,
    })
    .then(async () => {
      pendingOAuth.delete(challengeId);
      const now = Date.now();
      state.authProfiles = {
        ...state.authProfiles,
        profiles: state.authProfiles.profiles.map((p) =>
          p.id === meta.id ? { ...p, updatedAt: now, lastUsedAt: now } : p,
        ),
      };
      if (!state.authProfiles.defaultByProvider[providerId]) {
        state.authProfiles.defaultByProvider[providerId] = meta.id;
      }
      saveAuthProfiles(state);
      servicesForProfile(state, meta.id, { forceRefresh: true });
      try {
        await refreshTabsAfterAuthChange(state, deps, {
          profileId: meta.id,
          providerId,
          targetTabId: pending.targetTabId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.send({
          type: "error",
          message: `auth_profile_login_start: refresh session: ${message}`,
        });
      }
      deps.send({
        type: "auth_profile_login_event",
        event: {
          type: "complete",
          challengeId,
          profileId: meta.id,
          providerId,
          targetTabId: pending.targetTabId,
          ok: true,
        },
      });
      emitAuthProfiles(state, deps);
      try {
        await emitGlobalReady(state, deps);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.send({
          type: "error",
          message: `auth_profile_login_start: emit ready: ${message}`,
        });
      }
    })
    .catch((err: unknown) => {
      pendingOAuth.delete(challengeId);
      if (!isReauth) removeProfile(state, meta.id);
      saveAuthProfiles(state);
      const message = err instanceof Error ? err.message : String(err);
      deps.send({
        type: "auth_profile_login_event",
        event: {
          type: "complete",
          challengeId,
          profileId: meta.id,
          providerId,
          ok: false,
          error: message,
        },
      });
      emitAuthProfiles(state, deps);
    });
}

export function handleOAuthInput(msg: InboundMessage): void {
  const challengeId = stringField(msg.challengeId);
  const pending = challengeId ? pendingOAuth.get(challengeId) : undefined;
  if (!pending?.resolvePrompt) return;
  const resolve = pending.resolvePrompt;
  pending.resolvePrompt = undefined;
  resolve(stringField(msg.value));
}

export function handleOAuthCancel(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): void {
  const challengeId = stringField(msg.challengeId);
  const pending = challengeId ? pendingOAuth.get(challengeId) : undefined;
  if (!pending) return;
  pending.controller.abort();
  pendingOAuth.delete(challengeId);
  if (!pending.isReauth) removeProfile(state, pending.profileId);
  saveAuthProfiles(state);
  emitAuthProfiles(state, deps);
}
