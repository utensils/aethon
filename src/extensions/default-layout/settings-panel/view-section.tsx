import type { AethonConfig } from "../../../config";
import { Field, Section, type SettingsUpdate } from "./sections";

export function ViewSection({
  config,
  update,
}: {
  config: AethonConfig;
  update: SettingsUpdate;
}) {
  return (
    <Section id="view" title="View">
      <Field label="Thinking blocks (global default)">
        <select
          className="ae-settings-input"
          value={config.ui.thinkingVisibility === "show" ? "show" : "hide"}
          onChange={(e) =>
            update({
              ui: {
                ...config.ui,
                thinkingVisibility: e.target.value as "show" | "hide",
              },
            })
          }
        >
          <option value="show">On</option>
          <option value="hide">Off</option>
        </select>
      </Field>
      <Field label="Tool calls (global default)">
        <select
          className="ae-settings-input"
          value={config.ui.toolCallsVisibility === "show" ? "show" : "hide"}
          onChange={(e) =>
            update({
              ui: {
                ...config.ui,
                toolCallsVisibility: e.target.value as "show" | "hide",
              },
            })
          }
        >
          <option value="show">On</option>
          <option value="hide">Off</option>
        </select>
      </Field>
    </Section>
  );
}
