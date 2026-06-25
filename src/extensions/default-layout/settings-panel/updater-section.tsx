import type { AethonConfig } from "../../../config";
import { Field, Section, type SettingsUpdate } from "./sections";

export function UpdaterSection({
  config,
  update,
}: {
  config: AethonConfig;
  update: SettingsUpdate;
}) {
  return (
    <Section id="updater" title="Updater">
      <Field label="Release channel">
        <select
          className="ae-settings-input"
          value={config.updates.channel}
          onChange={(e) =>
            update({
              updates: {
                ...config.updates,
                channel: e.target.value === "nightly" ? "nightly" : "stable",
              },
            })
          }
        >
          <option value="stable">Stable</option>
          <option value="nightly">Nightly (latest from main)</option>
        </select>
      </Field>
      <Field label="Background update check">
        <input
          type="checkbox"
          checked={!config.updates.disableAutoCheck}
          onChange={(e) =>
            update({
              updates: {
                ...config.updates,
                disableAutoCheck: !e.target.checked,
              },
            })
          }
        />
      </Field>
      <p className="ae-settings-note">
        Stable tracks signed releases. Nightly follows the <code>nightly</code>{" "}
        tag — newer features, fewer guarantees. Each install backs up the
        previous build; a hang within ~20s of launch automatically rolls back.
      </p>
    </Section>
  );
}
