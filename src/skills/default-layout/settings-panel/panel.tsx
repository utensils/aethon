// Settings overlay (M6 P3). Cmd+, opens. Form-based editor for the
// most-used `~/.aethon/config.toml` keys; advanced power-user editing
// is a click away via the "Open config.toml" button.
//
// State contract (`/settings` slice on the main state object):
//   { open: boolean, focusSection: string | null,
//     pending: Partial<AethonConfig> | null }
//
// The panel reads the current config state via `getConfig()` on mount
// so the form reflects what's actually on disk, not stale in-memory
// tab state.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { AethonConfig } from "../../../config";
import { SHARE_MODES, type ShareMode } from "../../../utils/shareMode";
import { ANSI_PREVIEW_KEYS, BUILTIN_THEMES } from "./constants";
import { ExtensionsList } from "./extensions-list";
import {
  useConfigSnapshot,
  useEffectiveConfig,
  useScrollToSection,
} from "./hooks";
import { ModelPicker } from "./model-picker";
import { readSettingsState } from "./state";

export function SettingsPanel({ state, onEvent }: BuiltinComponentProps) {
  const settings = readSettingsState(state);
  const configSnapshot = useConfigSnapshot(settings.open);
  const eff = useEffectiveConfig(configSnapshot, settings.pending);
  useScrollToSection(settings.open, eff, settings.focusSection);

  if (!settings.open) return null;

  const update = (patch: Partial<AethonConfig>) => {
    onEvent("update", { patch });
  };
  const save = () => onEvent("save");
  const cancel = () => onEvent("close");
  // `aethon_home_dir` returns the *Aethon* dir (`~/.aethon`), not the
  // user's home — joining another `/.aethon/` produces a wrong nested
  // path that the agent never reads. Append the bare filename only.
  const openConfigFile = async () => {
    try {
      const aethonDir = (await invoke<string>("aethon_home_dir")) ?? "";
      const path = `${aethonDir}/config.toml`;
      await openUrl(`file://${path}`);
    } catch (err) {
      console.warn("open config.toml failed:", err);
    }
  };
  const openSystemPromptFile = () => {
    onEvent("open-system-prompt");
  };

  return (
    <div
      className="ae-settings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        className="ae-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <header className="ae-settings-header">
          <h2>Settings</h2>
          <button
            type="button"
            className="ae-settings-close"
            aria-label="Close"
            onClick={cancel}
          >
            ×
          </button>
        </header>

        {!eff ? (
          <div className="ae-settings-body">Loading…</div>
        ) : (
          <div className="ae-settings-body">
            <Section id="appearance" title="Appearance">
              <Field label="Theme">
                <select
                  className="ae-settings-input"
                  value={eff.ui.theme ?? "ember"}
                  onChange={(e) =>
                    update({ ui: { ...eff.ui, theme: e.target.value } })
                  }
                >
                  {BUILTIN_THEMES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Font size (px)">
                <input
                  type="number"
                  className="ae-settings-input"
                  min={10}
                  max={24}
                  value={eff.ui.fontSize ?? 14}
                  onChange={(e) =>
                    update({
                      ui: {
                        ...eff.ui,
                        fontSize: parseInt(e.target.value, 10) || 14,
                      },
                    })
                  }
                />
              </Field>
              <Field label="Restore tabs on launch">
                <input
                  type="checkbox"
                  checked={eff.ui.restoreTabs}
                  onChange={(e) =>
                    update({ ui: { ...eff.ui, restoreTabs: e.target.checked } })
                  }
                />
              </Field>
            </Section>

            <Section id="notifications" title="Notifications">
              <Field label="Notify on agent completion (when unfocused)">
                <input
                  type="checkbox"
                  checked={eff.ui.notifyOnCompletion}
                  onChange={(e) =>
                    update({
                      ui: { ...eff.ui, notifyOnCompletion: e.target.checked },
                    })
                  }
                />
              </Field>
              <Field label="Min turn duration (seconds)">
                <input
                  type="number"
                  className="ae-settings-input"
                  min={0}
                  max={3600}
                  value={eff.ui.notifyMinDurationSeconds}
                  onChange={(e) =>
                    update({
                      ui: {
                        ...eff.ui,
                        notifyMinDurationSeconds:
                          parseInt(e.target.value, 10) || 0,
                      },
                    })
                  }
                />
              </Field>
            </Section>

            <Section id="agent" title="Agent">
              <Field label="Default model for new tabs">
                <ModelPicker
                  state={state}
                  value={eff.agent.model ?? ""}
                  onChange={(next) =>
                    update({ agent: { ...eff.agent, model: next || null } })
                  }
                />
              </Field>
              <Field label="System prompt override">
                <button
                  type="button"
                  className="ae-settings-secondary"
                  onClick={openSystemPromptFile}
                  title="Open or create ~/.aethon/system-prompt.md"
                >
                  Open system-prompt.md
                </button>
              </Field>
            </Section>

            <Section id="shell" title="Shell">
              <Field label="Default share mode for new shell tabs">
                <select
                  className="ae-settings-input"
                  value={eff.shell.defaultShareMode}
                  onChange={(e) =>
                    update({
                      shell: {
                        ...eff.shell,
                        defaultShareMode: e.target.value as ShareMode,
                      },
                    })
                  }
                >
                  {SHARE_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Auto-restart agent on crash">
                <input
                  type="checkbox"
                  checked={eff.shell.autoRestartAgent}
                  onChange={(e) =>
                    update({
                      shell: {
                        ...eff.shell,
                        autoRestartAgent: e.target.checked,
                      },
                    })
                  }
                />
              </Field>
              <Field label="Default shell command (override $SHELL)">
                <input
                  type="text"
                  className="ae-settings-input"
                  placeholder="(uses $SHELL by default)"
                  value={eff.shell.defaultCommand ?? ""}
                  onChange={(e) =>
                    update({
                      shell: {
                        ...eff.shell,
                        defaultCommand: e.target.value || null,
                      },
                    })
                  }
                />
              </Field>
              <Field label="Inherit host environment">
                <input
                  type="checkbox"
                  checked={eff.shell.inheritEnv}
                  onChange={(e) =>
                    update({
                      shell: {
                        ...eff.shell,
                        inheritEnv: e.target.checked,
                      },
                    })
                  }
                />
              </Field>
            </Section>

            <Section id="behavior" title="Behavior">
              <Field label="Confirm close when shell job is running">
                <input
                  type="checkbox"
                  checked={eff.shell.promptBeforeClose}
                  onChange={(e) =>
                    update({
                      shell: {
                        ...eff.shell,
                        promptBeforeClose: e.target.checked,
                      },
                    })
                  }
                />
              </Field>
              <Field label="Cmd+T opens">
                <select
                  className="ae-settings-input"
                  value={eff.shortcuts.newTabKind}
                  onChange={(e) =>
                    update({
                      shortcuts: {
                        ...eff.shortcuts,
                        newTabKind:
                          e.target.value === "shell" ? "shell" : "agent",
                      },
                    })
                  }
                >
                  <option value="agent">
                    Agent tab (focus-aware default)
                  </option>
                  <option value="shell">Always a shell tab</option>
                </select>
              </Field>
              <div className="ae-settings-ansi-preview">
                <span className="ae-settings-field-label">
                  ANSI palette preview
                </span>
                <div className="ae-ansi-grid" aria-hidden="true">
                  {ANSI_PREVIEW_KEYS.map((key) => (
                    <span
                      key={key}
                      className="ae-ansi-swatch"
                      style={{ background: `var(${key})` }}
                      title={key}
                    />
                  ))}
                </div>
              </div>
            </Section>

            <Section id="updater" title="Updater">
              <Field label="Release channel">
                <select
                  className="ae-settings-input"
                  value="stable"
                  disabled
                  title="Multi-channel releases land in M7"
                >
                  <option value="stable">stable</option>
                  <option value="beta">beta (M7)</option>
                  <option value="nightly">nightly (M7)</option>
                </select>
              </Field>
              <p className="ae-settings-note">
                Channel selection ships with M7's release pipeline. Until
                then, update via the system menu's Check for Updates.
              </p>
            </Section>

            <Section id="extensions" title="Extensions">
              <ExtensionsList state={state} onEvent={onEvent} />
            </Section>

            <Section id="advanced" title="Advanced">
              <p className="ae-settings-note">
                For keys not surfaced here, edit{" "}
                <code>~/.aethon/config.toml</code> directly. The Save button
                round-trips comments and unknown keys, so hand edits survive.
              </p>
              <button
                type="button"
                className="ae-settings-secondary"
                onClick={() => onEvent("reset-layout-prefs")}
              >
                Reset layout
              </button>
              <button
                type="button"
                className="ae-settings-secondary"
                onClick={openConfigFile}
              >
                Open config.toml
              </button>
            </Section>
          </div>
        )}

        <footer className="ae-settings-footer">
          <button
            type="button"
            className="ae-settings-secondary"
            onClick={cancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ae-settings-primary"
            onClick={save}
            disabled={!eff || settings.pending === null}
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

function Section(props: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="ae-settings-section" data-settings-section={props.id}>
      <h3 className="ae-settings-section-title">{props.title}</h3>
      <div className="ae-settings-section-body">{props.children}</div>
    </section>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="ae-settings-field">
      <span className="ae-settings-field-label">{props.label}</span>
      <span className="ae-settings-field-control">{props.children}</span>
    </label>
  );
}
