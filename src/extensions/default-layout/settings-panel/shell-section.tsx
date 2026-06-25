import type { AethonConfig } from "../../../config";
import { SHARE_MODES, type ShareMode } from "../../../utils/shareMode";
import { Field, Section, type SettingsUpdate } from "./sections";

export function ShellSection({
  config,
  update,
}: {
  config: AethonConfig;
  update: SettingsUpdate;
}) {
  return (
    <Section id="shell" title="Shell">
      <Field label="Default share mode for new shell tabs">
        <select
          className="ae-settings-input"
          value={config.shell.defaultShareMode}
          onChange={(e) =>
            update({
              shell: {
                ...config.shell,
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
          checked={config.shell.autoRestartAgent}
          onChange={(e) =>
            update({
              shell: {
                ...config.shell,
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
          value={config.shell.defaultCommand ?? ""}
          onChange={(e) =>
            update({
              shell: {
                ...config.shell,
                defaultCommand: e.target.value || null,
              },
            })
          }
        />
      </Field>
      <Field label="Inherit host environment">
        <input
          type="checkbox"
          checked={config.shell.inheritEnv}
          onChange={(e) =>
            update({
              shell: {
                ...config.shell,
                inheritEnv: e.target.checked,
              },
            })
          }
        />
      </Field>
    </Section>
  );
}
