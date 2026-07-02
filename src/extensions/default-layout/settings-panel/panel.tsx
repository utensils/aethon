// Settings overlay. Cmd+, opens. Live editor for the most-used
// `~/.aethon/config.toml` keys; advanced power-user editing is a click
// away via the "Open config.toml" button.
//
// State contract (`/settings` slice on the main state object):
//   { open: boolean, focusSection: string | null,
//     pending: Partial<AethonConfig> | null,
//     saveStatus: "idle" | "saving" | "saved" | "error" }
//
// The panel reads the current config state via `getConfig()` on mount
// so the form reflects what's actually on disk, not stale in-memory
// tab state.
//
// Layout: a fixed nav rail (one entry per section, scrollspy-highlighted)
// beside one scrolling content pane. Clicking a rail entry scrolls its
// section to the top; the rail collapses on narrow windows.

import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { AethonConfig } from "../../../config";
import { AdvancedSection } from "./advanced-section";
import { AgentSection } from "./agent-section";
import { AppearanceSection } from "./appearance-section";
import { BehaviorSection } from "./behavior-section";
import { DevshellSection } from "./devshell-section";
import { ExtensionsList } from "./extensions-list";
import { GuardrailsSection } from "./guardrails-section";
import {
  useActiveSection,
  useConfigSnapshot,
  useEffectiveConfig,
  useScrollToSection,
} from "./hooks";
import { NotificationsSection } from "./notifications-section";
import { RemoteDevicesSection } from "./remote-section";
import { SaveState, Section } from "./sections";
import { readSettingsState } from "./state";
import { ShellSection } from "./shell-section";
import { UpdaterSection } from "./updater-section";
import { ViewSection } from "./view-section";
import { VoiceSection } from "./voice-section";

/** Nav rail entries, in render order. Ids match each section's
 *  `data-settings-section` anchor. */
const SETTINGS_NAV: { id: string; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "view", label: "View" },
  { id: "guardrails", label: "Guardrails" },
  { id: "notifications", label: "Notifications" },
  { id: "agent", label: "Agent" },
  { id: "shell", label: "Shell" },
  { id: "behavior", label: "Behavior" },
  { id: "voice", label: "Voice" },
  { id: "updater", label: "Updater" },
  { id: "remote", label: "Remote devices" },
  { id: "devshell", label: "Nix devshell" },
  { id: "extensions", label: "Extensions" },
  { id: "advanced", label: "Advanced" },
];

export function SettingsPanel({ state, onEvent }: BuiltinComponentProps) {
  const settings = readSettingsState(state);
  const configSnapshot = useConfigSnapshot(settings.open);
  const eff = useEffectiveConfig(configSnapshot, settings.pending);
  useScrollToSection(settings.open, eff, settings.focusSection);
  const [activeSection, setActiveSection] = useActiveSection(
    settings.open,
    eff !== null,
    settings.focusSection ?? "appearance",
  );

  if (!settings.open) return null;

  const update = (patch: Partial<AethonConfig>) => {
    onEvent("update", { patch });
  };
  const close = () => onEvent("close");
  const openSystemPromptFile = () => {
    onEvent("open-system-prompt");
  };
  const jumpToSection = (id: string) => {
    setActiveSection(id);
    const target = [
      ...document.querySelectorAll<HTMLElement>("[data-settings-section]"),
    ].find((el) => el.dataset.settingsSection === id);
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    target?.scrollIntoView({
      block: "start",
      behavior: reduced ? "auto" : "smooth",
    });
  };

  return (
    <div
      className="ae-settings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
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
          <SaveState settings={settings} />
          <button
            type="button"
            className="ae-settings-close"
            aria-label="Close"
            onClick={close}
          >
            ×
          </button>
        </header>

        {!eff ? (
          <div className="ae-settings-body">Loading…</div>
        ) : (
          <div className="ae-settings-layout">
            <nav className="ae-settings-nav" aria-label="Settings sections">
              {SETTINGS_NAV.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`ae-settings-nav-item${
                    activeSection === entry.id
                      ? " ae-settings-nav-item--active"
                      : ""
                  }`}
                  aria-current={
                    activeSection === entry.id ? "true" : undefined
                  }
                  onClick={() => jumpToSection(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </nav>
            <div className="ae-settings-body">
              <AppearanceSection config={eff} update={update} />
              <ViewSection config={eff} update={update} />
              <GuardrailsSection config={eff} update={update} />
              <NotificationsSection config={eff} update={update} />
              <AgentSection
                config={eff}
                onOpenSystemPromptFile={openSystemPromptFile}
                update={update}
              />
              <ShellSection config={eff} update={update} />
              <BehaviorSection config={eff} update={update} />
              <VoiceSection config={eff} update={update} />
              <UpdaterSection config={eff} update={update} />
              <RemoteDevicesSection open={settings.open} />
              <DevshellSection config={eff} state={state} update={update} />
              <Section id="extensions" title="Extensions">
                <ExtensionsList state={state} onEvent={onEvent} />
              </Section>
              <AdvancedSection onEvent={onEvent} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
