import type { AethonConfig } from "../../../config";
import { BUILTIN_THEMES } from "./constants";
import { Field, Section, type SettingsUpdate } from "./sections";

export function AppearanceSection({
  config,
  update,
}: {
  config: AethonConfig;
  update: SettingsUpdate;
}) {
  return (
    <Section id="appearance" title="Appearance">
      <Field label="Theme">
        <select
          className="ae-settings-input"
          value={config.ui.theme ?? "ember"}
          onChange={(e) =>
            update({ ui: { ...config.ui, theme: e.target.value } })
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
          value={config.ui.fontSize ?? 14}
          onChange={(e) =>
            update({
              ui: {
                ...config.ui,
                fontSize: parseInt(e.target.value, 10) || 14,
              },
            })
          }
        />
      </Field>
    </Section>
  );
}
