import type { AethonConfig } from "../../../config";
import { formatVoiceDownloadProgress } from "../../../utils/voice";
import { Field, Section, type SettingsUpdate } from "./sections";
import { useVoiceProviders } from "./useVoiceProviders";

export function VoiceSection({
  config,
  update,
}: {
  config: AethonConfig;
  update: SettingsUpdate;
}) {
  return (
    <Section id="voice" title="Voice">
      <Field label="Toggle hotkey">
        <input
          type="text"
          className="ae-settings-input"
          value={config.voice.toggleHotkey ?? ""}
          placeholder="mod+shift+m"
          onChange={(e) =>
            update({
              voice: {
                ...config.voice,
                toggleHotkey: e.target.value || null,
              },
            })
          }
        />
      </Field>
      <Field label="Hold-to-talk key">
        <input
          type="text"
          className="ae-settings-input"
          value={config.voice.holdHotkey ?? ""}
          placeholder="AltRight"
          onChange={(e) =>
            update({
              voice: {
                ...config.voice,
                holdHotkey: e.target.value || null,
              },
            })
          }
        />
      </Field>
      <Field label="Speak agent replies aloud (LFM2-Audio)">
        <input
          type="checkbox"
          checked={config.voice.speakAgentReplies}
          onChange={(e) =>
            update({
              voice: {
                ...config.voice,
                speakAgentReplies: e.target.checked,
              },
            })
          }
        />
      </Field>
      <Field label="Spoken reply length (characters)">
        <input
          type="number"
          className="ae-settings-input"
          min={50}
          max={5000}
          value={config.voice.speakMaxChars}
          onChange={(e) =>
            update({
              voice: {
                ...config.voice,
                speakMaxChars: Number(e.target.value) || 600,
              },
            })
          }
        />
      </Field>
      <Field label="Hands-free conversation (auto-reopen mic)">
        <input
          type="checkbox"
          checked={config.voice.conversationContinuous}
          onChange={(e) =>
            update({
              voice: {
                ...config.voice,
                conversationContinuous: e.target.checked,
              },
            })
          }
        />
      </Field>
      <VoiceProviders />
    </Section>
  );
}

function VoiceProviders() {
  const {
    providers,
    busyProvider,
    error,
    progress,
    prepareProvider,
    removeProviderModel,
    selectProvider,
    setProviderEnabled,
  } = useVoiceProviders();

  if (!providers)
    return <p className="ae-settings-note">Loading voice providers...</p>;

  return (
    <div className="ae-voice-provider-list">
      {error ? (
        <p className="ae-settings-note ae-voice-error">{error}</p>
      ) : null}
      {providers.map((provider) => {
        const isBusy = busyProvider === provider.id;
        const providerProgress =
          progress?.providerId === provider.id ? progress : null;
        const isDownloading =
          provider.status === "downloading" || providerProgress !== null;
        return (
          <div key={provider.id} className="ae-voice-provider-card">
            <div className="ae-voice-provider-head">
              <div>
                <strong>{provider.name}</strong>
                <p>{provider.description}</p>
              </div>
              <label>
                <input
                  type="radio"
                  name="voice-provider"
                  checked={provider.selected}
                  disabled={!provider.enabled}
                  onChange={() => selectProvider(provider.id)}
                />
                Use
              </label>
            </div>
            <div className="ae-voice-provider-meta">
              <span>{provider.statusLabel}</span>
              <span>{provider.privacyLabel}</span>
              {provider.modelSizeLabel ? (
                <span>{provider.modelSizeLabel}</span>
              ) : null}
              {provider.acceleratorLabel ? (
                <span>{provider.acceleratorLabel}</span>
              ) : null}
              {provider.cachePath ? <code>{provider.cachePath}</code> : null}
            </div>
            {provider.error ? (
              <p className="ae-settings-note ae-voice-error">
                {provider.error}
              </p>
            ) : null}
            {providerProgress ? (
              <p className="ae-settings-note">
                Downloading {providerProgress.filename}:{" "}
                {formatVoiceDownloadProgress(providerProgress)}
              </p>
            ) : null}
            <div className="ae-voice-provider-actions">
              <button
                type="button"
                className="ae-settings-secondary"
                disabled={isBusy || isDownloading}
                onClick={() =>
                  setProviderEnabled(provider.id, !provider.enabled)
                }
              >
                {provider.enabled ? "Disable" : "Enable"}
              </button>
              {provider.setupRequired ? (
                <button
                  type="button"
                  className="ae-settings-secondary"
                  disabled={isBusy || isDownloading}
                  onClick={() => prepareProvider(provider.id)}
                >
                  {isDownloading
                    ? "Downloading..."
                    : provider.downloadRequired
                      ? "Download model"
                      : "Set up permissions"}
                </button>
              ) : null}
              {provider.canRemoveModel ? (
                <button
                  type="button"
                  className="ae-settings-secondary"
                  disabled={isBusy}
                  onClick={() => removeProviderModel(provider.id)}
                >
                  Remove model
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
