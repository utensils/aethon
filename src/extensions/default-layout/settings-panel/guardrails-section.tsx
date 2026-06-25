import type { AethonConfig } from "../../../config";
import { Field, Section, type SettingsUpdate } from "./sections";

export function GuardrailsSection({
  config,
  update,
}: {
  config: AethonConfig;
  update: SettingsUpdate;
}) {
  return (
    <Section id="guardrails" title="Guardrails">
      <Field label="Restrict agent tools to the project root (default for new sessions)">
        <input
          type="checkbox"
          checked={config.guardrails.hardEnforceProjectRoot}
          onChange={(e) =>
            update({
              guardrails: {
                ...config.guardrails,
                hardEnforceProjectRoot: e.target.checked,
              },
            })
          }
        />
      </Field>
      <Field label="Soft prompt anchor (advisory text injected every turn)">
        <textarea
          className="ae-settings-input"
          rows={3}
          placeholder="e.g. Only modify files under src/. Never run destructive git commands."
          value={config.guardrails.softPromptAnchor ?? ""}
          onChange={(e) =>
            update({
              guardrails: {
                ...config.guardrails,
                softPromptAnchor:
                  e.target.value.trim().length > 0 ? e.target.value : null,
              },
            })
          }
        />
      </Field>
    </Section>
  );
}
