import type { AethonConfig } from "../../../config";
import { ANSI_PREVIEW_KEYS } from "./constants";
import { Field, Section, type SettingsUpdate } from "./sections";

export function BehaviorSection({
  config,
  update,
}: {
  config: AethonConfig;
  update: SettingsUpdate;
}) {
  return (
    <Section id="behavior" title="Behavior">
      <Field label="Confirm close when shell job is running">
        <input
          type="checkbox"
          checked={config.shell.promptBeforeClose}
          onChange={(e) =>
            update({
              shell: {
                ...config.shell,
                promptBeforeClose: e.target.checked,
              },
            })
          }
        />
      </Field>
      <div className="ae-settings-ansi-preview">
        <span className="ae-settings-field-label">ANSI palette preview</span>
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
  );
}
