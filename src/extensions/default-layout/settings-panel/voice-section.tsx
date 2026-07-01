import { useState } from "react";
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
      <ConversationSettings config={config} update={update} />
      <VoiceProviders />
    </Section>
  );
}

/** The cascade conversation pipeline: engine choice, voice-brain model, TTS
 *  voice, and the two provider API keys (write-only — the UI only ever sees
 *  presence booleans; env vars take precedence over stored keys). */
function ConversationSettings({
  config,
  update,
}: {
  config: AethonConfig;
  update: SettingsUpdate;
}) {
  return (
    <div className="ae-voice-conversation-settings">
      <h4 className="ae-settings-subhead">Conversation</h4>
      <Field label="Conversation engine">
        <select
          className="ae-settings-input"
          value={config.voice.conversationEngine}
          onChange={(e) =>
            update({
              voice: {
                ...config.voice,
                conversationEngine:
                  e.target.value === "cascade"
                    ? "cascade"
                    : e.target.value === "lfm2"
                      ? "lfm2"
                      : "auto",
              },
            })
          }
        >
          <option value="auto">Auto (cascade when keys are set)</option>
          <option value="cascade">Cascade (Deepgram + Cartesia)</option>
          <option value="lfm2">Local (LFM2-Audio)</option>
        </select>
      </Field>
      <Field label="Voice brain model (empty = default model)">
        <input
          type="text"
          className="ae-settings-input"
          value={config.voice.brainModel ?? ""}
          placeholder="anthropic/claude-haiku-4-5"
          onChange={(e) =>
            update({
              voice: {
                ...config.voice,
                brainModel: e.target.value.trim() || null,
              },
            })
          }
        />
      </Field>
      <Field label="Cartesia voice id (empty = default voice)">
        <input
          type="text"
          className="ae-settings-input"
          value={config.voice.ttsVoice ?? ""}
          onChange={(e) =>
            update({
              voice: {
                ...config.voice,
                ttsVoice: e.target.value.trim() || null,
              },
            })
          }
        />
      </Field>
      <ApiKeyField
        label="Deepgram API key"
        stored={config.voice.deepgramApiKeySet}
        envVar="DEEPGRAM_API_KEY"
        onSave={(value) =>
          update({ voice: { ...config.voice, deepgramApiKey: value } })
        }
      />
      <ApiKeyField
        label="Cartesia API key"
        stored={config.voice.cartesiaApiKeySet}
        envVar="CARTESIA_API_KEY"
        onSave={(value) =>
          update({ voice: { ...config.voice, cartesiaApiKey: value } })
        }
      />
    </div>
  );
}

/** Masked, write-only key input: the stored value never round-trips to the
 *  UI. Saving sends the typed key once; clearing sends an explicit "". */
function ApiKeyField({
  label,
  stored,
  envVar,
  onSave,
}: {
  label: string;
  stored: boolean;
  envVar: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <Field label={label}>
      <div className="ae-voice-key-row">
        <input
          type="password"
          className="ae-settings-input"
          value={draft}
          placeholder={stored ? "•••••••• (stored)" : `or set ${envVar}`}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          className="ae-settings-secondary"
          disabled={!draft.trim()}
          onClick={() => {
            onSave(draft.trim());
            setDraft("");
          }}
        >
          Set key
        </button>
        {stored ? (
          <button
            type="button"
            className="ae-settings-secondary"
            onClick={() => {
              onSave("");
              setDraft("");
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
    </Field>
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
