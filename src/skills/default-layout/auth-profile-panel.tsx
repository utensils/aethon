import { useMemo, useState } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import {
  EMPTY_AUTH_PROFILES,
  sendAuthProfileCommand,
  type AuthProfileLoginEvent,
  type AuthProfileProvider,
  type AuthProfilesUiState,
} from "../../auth-profiles";

function readAuthProfiles(state: Record<string, unknown>): AuthProfilesUiState {
  return {
    ...EMPTY_AUTH_PROFILES,
    ...((state.authProfiles as AuthProfilesUiState | undefined) ?? {}),
  };
}

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

  const startLogin = async () => {
    if (!selectedProvider) return;
    await sendAuthProfileCommand({
      type:
        selectedProvider.kind === "oauth"
          ? "auth_profile_login_start"
          : "auth_profile_api_key_save",
      providerId: selectedProvider.id,
      label: label.trim() || selectedProvider.label,
      ...(selectedProvider.kind === "api_key" ? { key: apiKey } : {}),
    });
    if (selectedProvider.kind === "api_key") {
      setApiKey("");
      setLabel("");
    }
  };

  const activateProfile = (profileId: string) =>
    sendAuthProfileCommand({
      type: "auth_profile_use_for_tab",
      tabId: activeTabId,
      profileId,
    });

  const setDefault = (profileId: string) =>
    sendAuthProfileCommand({ type: "auth_profile_set_default", profileId });

  const deleteProfile = (profileId: string) =>
    sendAuthProfileCommand({ type: "auth_profile_delete", profileId });

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
                  return (
                    <li key={profile.id} className="ae-auth-row">
                      <div className="ae-auth-row-main">
                        <strong>{profile.label}</strong>
                        <span>
                          {profile.provider.label} · {profile.kind}
                          {isActive ? " · active" : ""}
                          {isDefault ? " · default" : ""}
                        </span>
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
