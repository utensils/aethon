import type { ReactNode } from "react";

import type { AethonConfig } from "../../../config";
import type { readSettingsState } from "./state";

export type SettingsUpdate = (patch: Partial<AethonConfig>) => void;

export function SaveState({
  settings,
}: {
  settings: ReturnType<typeof readSettingsState>;
}) {
  if (settings.saveStatus === "idle") return null;
  const label =
    settings.saveStatus === "saving"
      ? "Saving..."
      : settings.saveStatus === "error"
        ? "Save failed"
        : "Saved";
  return (
    <span
      className={`ae-settings-save-state ae-settings-save-state--${settings.saveStatus}`}
      aria-live="polite"
      title={settings.saveError ?? undefined}
    >
      {label}
    </span>
  );
}

export function Section(props: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="ae-settings-section" data-settings-section={props.id}>
      <h3 className="ae-settings-section-title">{props.title}</h3>
      <div className="ae-settings-section-body">{props.children}</div>
    </section>
  );
}

export function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="ae-settings-field">
      <span className="ae-settings-field-label">{props.label}</span>
      <span className="ae-settings-field-control">{props.children}</span>
    </label>
  );
}
