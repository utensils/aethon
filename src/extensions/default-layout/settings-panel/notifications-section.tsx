import type { AethonConfig } from "../../../config";
import { Field, Section, type SettingsUpdate } from "./sections";

export function NotificationsSection({
  config,
  update,
}: {
  config: AethonConfig;
  update: SettingsUpdate;
}) {
  return (
    <Section id="notifications" title="Notifications">
      <Field label="Notify on agent completion (when unfocused)">
        <input
          type="checkbox"
          checked={config.ui.notifyOnCompletion}
          onChange={(e) =>
            update({
              ui: { ...config.ui, notifyOnCompletion: e.target.checked },
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
          value={config.ui.notifyMinDurationSeconds}
          onChange={(e) =>
            update({
              ui: {
                ...config.ui,
                notifyMinDurationSeconds: parseInt(e.target.value, 10) || 0,
              },
            })
          }
        />
      </Field>
    </Section>
  );
}
