// Settings overlay (M6 P3). Cmd+, opens. Form-based editor for the
// most-used `~/.aethon/config.toml` keys; advanced power-user editing
// is a click away via the "Open config.toml" button.
//
// State contract (`/settings` slice on the main state object):
//   { open: boolean, pending: { ui?, agent?, shell? } | null }
//
// `pending` mirrors the user's unsaved edits — the form binds form
// controls to it via $ref-style optimistic writes, so the user sees
// changes apply live. Save serializes `pending` and invokes the Tauri
// `write_config` command; Cancel discards `pending`. The panel reads
// the current config state via `getConfig()` on mount so the form
// reflects what's actually on disk, not stale in-memory tab state.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import { getConfig, type AethonConfig } from "../../config";
import { SHARE_MODES, type ShareMode } from "../../utils/shareMode";

interface SettingsState {
  open: boolean;
  /** User's unsaved edits. Null when the panel hasn't loaded the
   *  config yet OR the user hasn't touched anything. The form reads
   *  from `pending` first, falling back to the config snapshot. */
  pending: Partial<AethonConfig> | null;
}

function readSettingsState(state: Record<string, unknown>): SettingsState {
  const s = (state.settings as Partial<SettingsState> | undefined) ?? {};
  return {
    open: !!s.open,
    pending: (s.pending as Partial<AethonConfig> | null) ?? null,
  };
}

const BUILTIN_THEMES = [
  { id: "ember", label: "Ember — warm dark" },
  { id: "paper", label: "Paper — cream light" },
  { id: "aether", label: "Æther — signature" },
  { id: "brink", label: "Brink — Ristretto warm chrome with gold accent" },
];

// 16-swatch ANSI preview block — order matches xterm's standard ANSI
// indices (0..7 standard + 8..15 bright) so users reading a terminal
// `\x1b[34m` recognise the swatch position. Bound to CSS vars so the
// preview tracks the active theme live.
const ANSI_PREVIEW_KEYS = [
  "--ansi-black",
  "--ansi-red",
  "--ansi-green",
  "--ansi-yellow",
  "--ansi-blue",
  "--ansi-magenta",
  "--ansi-cyan",
  "--ansi-white",
  "--ansi-bright-black",
  "--ansi-bright-red",
  "--ansi-bright-green",
  "--ansi-bright-yellow",
  "--ansi-bright-blue",
  "--ansi-bright-magenta",
  "--ansi-bright-cyan",
  "--ansi-bright-white",
] as const;

export function SettingsPanel({ state, onEvent }: BuiltinComponentProps) {
  const settings = readSettingsState(state);

  // Live config snapshot. Loaded via getConfig() on first open of
  // the panel and refreshed on save round-trips. Held in state (not
  // a ref) so the form re-renders when the value lands.
  const [configSnapshot, setConfigSnapshot] = useState<AethonConfig | null>(
    null,
  );
  useEffect(() => {
    if (!settings.open) return;
    let cancelled = false;
    void getConfig().then((cfg) => {
      if (!cancelled) setConfigSnapshot(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, [settings.open]);

  // Effective config = pending overlay over live config snapshot.
  // Form bindings read from this; Save / cancel manipulate `pending`.
  const eff = useMemo<AethonConfig | null>(() => {
    if (!configSnapshot) return null;
    const p = settings.pending ?? {};
    return {
      ui: { ...configSnapshot.ui, ...(p.ui ?? {}) },
      agent: { ...configSnapshot.agent, ...(p.agent ?? {}) },
      shell: { ...configSnapshot.shell, ...(p.shell ?? {}) },
      shortcuts: { ...configSnapshot.shortcuts, ...(p.shortcuts ?? {}) },
    };
  }, [configSnapshot, settings.pending]);

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
  const openSystemPromptFile = async () => {
    try {
      const aethonDir = (await invoke<string>("aethon_home_dir")) ?? "";
      const path = `${aethonDir}/system-prompt.md`;
      await openUrl(`file://${path}`);
    } catch (err) {
      console.warn("open system-prompt.md failed:", err);
    }
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
            <Section title="Appearance">
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

            <Section title="Notifications">
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

            <Section title="Agent">
              <Field label="Default model for new tabs">
                <input
                  type="text"
                  className="ae-settings-input"
                  placeholder="anthropic/claude-sonnet-4-6"
                  value={eff.agent.model ?? ""}
                  onChange={(e) =>
                    update({
                      agent: { ...eff.agent, model: e.target.value || null },
                    })
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

            <Section title="Shell">
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

            <Section title="Behavior">
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

            <Section title="Updater">
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

            <Section title="Advanced">
              <p className="ae-settings-note">
                For keys not surfaced here, edit{" "}
                <code>~/.aethon/config.toml</code> directly. The Save button
                round-trips comments and unknown keys, so hand edits survive.
              </p>
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

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="ae-settings-section">
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
