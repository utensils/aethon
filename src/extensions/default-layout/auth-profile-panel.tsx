import { useEffect, useMemo, useRef, useState } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import {
  EMPTY_AUTH_PROFILES,
  sendAuthProfileCommand,
  switchAccountForTab,
  type AuthProfileLoginEvent,
  type AuthProfileProvider,
  type AuthProfileUsage,
  type AuthProfilesUiState,
} from "../../auth-profiles";

function readAuthProfiles(state: Record<string, unknown>): AuthProfilesUiState {
  return {
    ...EMPTY_AUTH_PROFILES,
    ...((state.authProfiles as AuthProfilesUiState | undefined) ?? {}),
  };
}

const USAGE_STALE_MS = 5 * 60 * 1000;

export function AuthProfilePanel({
  state,
  onEvent,
  tabId,
}: BuiltinComponentProps) {
  const auth = readAuthProfiles(state);
  const [providerId, setProviderId] = useState("");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [promptValue, setPromptValue] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const providers = auth.providers;
  const selectedProvider =
    providers.find((p) => p.id === providerId) ?? providers[0];
  const activeTabId =
    tabId ??
    (typeof state.activeTabId === "string" ? state.activeTabId : "default");
  const activeProfileId = auth.activeByTab[activeTabId];

  const groupedProfiles = useMemo(
    () =>
      auth.profiles.map((profile) => ({
        ...profile,
        provider:
          providers.find((p) => p.id === profile.providerId) ??
          ({
            id: profile.providerId,
            label: profile.providerId,
            kind: profile.kind,
            configured: false,
            modelCount: 0,
          } satisfies AuthProfileProvider),
      })),
    [auth.profiles, providers],
  );

  useEffect(() => {
    if (!auth.modal?.open) return;
    const now = Date.now();
    for (const profile of auth.profiles) {
      if (profile.kind !== "oauth") continue;
      const cached = auth.usage?.[profile.id];
      if (cached && now - cached.fetchedAt < USAGE_STALE_MS) continue;
      void sendAuthProfileCommand({
        type: "auth_profile_fetch_usage",
        profileId: profile.id,
      });
    }
  }, [auth.modal?.open, auth.profiles, auth.usage]);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  const startLogin = async () => {
    if (!selectedProvider) return;
    await sendAuthProfileCommand({
      type:
        selectedProvider.kind === "oauth"
          ? "auth_profile_login_start"
          : "auth_profile_api_key_save",
      providerId: selectedProvider.id,
      label: label.trim() || selectedProvider.label,
      tabId: activeTabId,
      ...(selectedProvider.kind === "api_key" ? { key: apiKey } : {}),
    });
    if (selectedProvider.kind === "api_key") {
      setApiKey("");
      setLabel("");
    }
  };

  const activateProfile = (profileId: string) =>
    switchAccountForTab(activeTabId, profileId);

  const setDefault = (profileId: string) =>
    sendAuthProfileCommand({ type: "auth_profile_set_default", profileId });

  const reauthProfile = (profile: {
    id: string;
    providerId: string;
    label: string;
  }) =>
    sendAuthProfileCommand({
      type: "auth_profile_login_start",
      providerId: profile.providerId,
      profileId: profile.id,
      label: profile.label,
      tabId: activeTabId,
    });

  const deleteProfile = (profileId: string) =>
    sendAuthProfileCommand({ type: "auth_profile_delete", profileId });

  const startRename = (profileId: string, currentLabel: string) => {
    setRenamingId(profileId);
    setRenameValue(currentLabel);
  };

  const commitRename = () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    void sendAuthProfileCommand({
      type: "auth_profile_rename",
      profileId: renamingId,
      label: renameValue.trim(),
    });
    setRenamingId(null);
  };

  const submitPrompt = async (event: AuthProfileLoginEvent) => {
    await sendAuthProfileCommand({
      type: "auth_profile_oauth_input",
      challengeId: event.challengeId,
      value: promptValue,
    });
    setPromptValue("");
  };

  if (!auth.modal?.open) return null;

  return (
    <div
      className="ae-settings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onEvent("close");
      }}
    >
      <div
        className="ae-settings-panel ae-auth-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Accounts"
      >
        <header className="ae-settings-header">
          <h2>Accounts</h2>
          <button
            type="button"
            className="ae-settings-close"
            aria-label="Close"
            onClick={() => onEvent("close")}
          >
            ×
          </button>
        </header>

        <div className="ae-settings-body">
          <section className="ae-settings-section">
            <h3 className="ae-settings-section-title">Add Account</h3>
            <div className="ae-auth-add">
              <select
                className="ae-settings-input"
                value={selectedProvider?.id ?? ""}
                onChange={(e) => setProviderId(e.target.value)}
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
              <input
                className="ae-settings-input"
                value={label}
                placeholder="Account label"
                onChange={(e) => setLabel(e.target.value)}
              />
              {selectedProvider?.kind === "api_key" && (
                <input
                  className="ae-settings-input"
                  type="password"
                  value={apiKey}
                  placeholder="API key"
                  onChange={(e) => setApiKey(e.target.value)}
                />
              )}
              <button
                type="button"
                className="ae-settings-primary"
                disabled={
                  !selectedProvider ||
                  (selectedProvider.kind === "api_key" && !apiKey.trim())
                }
                onClick={() => void startLogin()}
              >
                {selectedProvider?.kind === "oauth" ? "Login" : "Save Key"}
              </button>
            </div>
            <LoginStatus
              event={auth.login}
              value={promptValue}
              onChange={setPromptValue}
              onSubmit={submitPrompt}
            />
          </section>

          <section className="ae-settings-section">
            <h3 className="ae-settings-section-title">Stored Accounts</h3>
            {groupedProfiles.length === 0 ? (
              <p className="ae-settings-note">No accounts stored yet.</p>
            ) : (
              <ul className="ae-auth-list">
                {groupedProfiles.map((profile) => {
                  const isActive = activeProfileId === profile.id;
                  const isDefault =
                    auth.defaultByProvider[profile.providerId] === profile.id;
                  const usage = auth.usage?.[profile.id];
                  const isRenaming = renamingId === profile.id;
                  return (
                    <li
                      key={profile.id}
                      className={`ae-auth-row${isActive ? " ae-auth-row--active" : ""}`}
                    >
                      <div className="ae-auth-row-main">
                        <div className="ae-auth-row-label">
                          {isRenaming ? (
                            <input
                              ref={renameInputRef}
                              className="ae-settings-input ae-auth-rename-input"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onBlur={commitRename}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitRename();
                                if (e.key === "Escape") setRenamingId(null);
                              }}
                            />
                          ) : (
                            <strong
                              className="ae-auth-row-name"
                              onDoubleClick={() =>
                                startRename(profile.id, profile.label)
                              }
                              title="Double-click to rename"
                            >
                              {profile.label}
                            </strong>
                          )}
                          {isActive && (
                            <span className="ae-auth-badge ae-auth-badge--active">
                              Active
                            </span>
                          )}
                          {isDefault && (
                            <span className="ae-auth-badge ae-auth-badge--default">
                              Default
                            </span>
                          )}
                        </div>
                        {usage?.email && (
                          <span className="ae-auth-row-email" title={usage.email}>
                            {usage.email}
                          </span>
                        )}
                        <span className="ae-auth-row-meta">
                          {profile.provider.label} · {profile.kind}
                          {usage?.planType ? ` · ${usage.planType}` : ""}
                        </span>
                        {usage && !usage.error && usage.primary && (
                          <UsageMeter usage={usage} />
                        )}
                        {usage?.error && (
                          <span className="ae-auth-usage-error">
                            {usage.error}
                          </span>
                        )}
                      </div>
                      <div className="ae-auth-row-actions">
                        <button
                          type="button"
                          className="ae-settings-secondary"
                          disabled={isActive}
                          onClick={() => void activateProfile(profile.id)}
                        >
                          Use
                        </button>
                        <button
                          type="button"
                          className="ae-settings-secondary"
                          disabled={isDefault}
                          onClick={() => void setDefault(profile.id)}
                        >
                          Default
                        </button>
                        <button
                          type="button"
                          className="ae-settings-secondary"
                          onClick={() =>
                            startRename(profile.id, profile.label)
                          }
                        >
                          Rename
                        </button>
                        {profile.kind === "oauth" && (
                          <button
                            type="button"
                            className="ae-settings-secondary"
                            onClick={() => void reauthProfile(profile)}
                          >
                            Re-auth
                          </button>
                        )}
                        <button
                          type="button"
                          className="ae-settings-secondary ae-auth-btn-danger"
                          onClick={() => void deleteProfile(profile.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function UsageMeter({ usage }: { usage: AuthProfileUsage }) {
  const { primary, secondary, credits } = usage;
  return (
    <div className="ae-auth-usage">
      {primary && (
        <div className="ae-auth-usage-bar-group">
          <div className="ae-auth-usage-bar-header">
            <span>{windowLabel(primary.windowDurationMins, "Primary")}</span>
            <span>{primary.usedPercent}%</span>
          </div>
          <div className="ae-auth-usage-bar-track">
            <div
              className={`ae-auth-usage-bar-fill${primary.usedPercent >= 90 ? " ae-auth-usage-bar-fill--danger" : primary.usedPercent >= 70 ? " ae-auth-usage-bar-fill--warn" : ""}`}
              style={{ width: `${Math.min(primary.usedPercent, 100)}%` }}
            />
          </div>
          {primary.resetsAt != null && (
            <span className="ae-auth-usage-reset">
              Resets {formatResetTime(primary.resetsAt)}
            </span>
          )}
        </div>
      )}
      {secondary && (
        <div className="ae-auth-usage-bar-group">
          <div className="ae-auth-usage-bar-header">
            <span>{windowLabel(secondary.windowDurationMins, "Secondary")}</span>
            <span>{secondary.usedPercent}%</span>
          </div>
          <div className="ae-auth-usage-bar-track">
            <div
              className={`ae-auth-usage-bar-fill${secondary.usedPercent >= 90 ? " ae-auth-usage-bar-fill--danger" : secondary.usedPercent >= 70 ? " ae-auth-usage-bar-fill--warn" : ""}`}
              style={{ width: `${Math.min(secondary.usedPercent, 100)}%` }}
            />
          </div>
          {secondary.resetsAt != null && (
            <span className="ae-auth-usage-reset">
              Resets {formatResetTime(secondary.resetsAt)}
            </span>
          )}
        </div>
      )}
      {credits && credits.balance != null && (
        <span className="ae-auth-usage-credits">
          Credits: ${credits.balance}
          {credits.unlimited ? " (unlimited)" : ""}
        </span>
      )}
    </div>
  );
}

function windowLabel(durationMins: number | undefined, fallback: string): string {
  switch (durationMins) {
    case 300:
      return "5-hour";
    case 10080:
      return "Weekly";
    case 43200:
      return "Monthly";
    default:
      return fallback;
  }
}

function formatResetTime(epochMs: number): string {
  const ms = epochMs > 1e12 ? epochMs : epochMs * 1000;
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.ceil(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return `in ${hrs}h ${remMins}m`;
  const days = Math.floor(hrs / 24);
  return `in ${days}d ${hrs % 24}h`;
}

function LoginStatus({
  event,
  value,
  onChange,
  onSubmit,
}: {
  event?: AuthProfileLoginEvent;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: AuthProfileLoginEvent) => Promise<void>;
}) {
  if (!event) return null;
  if (event.type === "prompt") {
    return (
      <div className="ae-auth-login">
        <p className="ae-settings-note">{event.message}</p>
        <div className="ae-auth-add">
          <input
            className="ae-settings-input"
            value={value}
            placeholder={event.placeholder ?? "Code or callback URL"}
            onChange={(e) => onChange(e.target.value)}
          />
          <button
            type="button"
            className="ae-settings-primary"
            disabled={!event.allowEmpty && !value.trim()}
            onClick={() => void onSubmit(event)}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }
  if (event.type === "auth" && event.url) {
    return (
      <p className="ae-settings-note">
        Browser login opened. If it did not, open the provider login URL from
        your browser.
      </p>
    );
  }
  if (event.message || event.error) {
    return <p className="ae-settings-note">{event.error ?? event.message}</p>;
  }
  return null;
}
