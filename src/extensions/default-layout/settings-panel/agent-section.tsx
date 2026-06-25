import {
  DEFAULT_AGENT_TIMEOUT_SECONDS,
  MAX_AGENT_TIMEOUT_SECONDS,
  type AethonConfig,
} from "../../../config";
import { Field, Section, type SettingsUpdate } from "./sections";
import { clampTimeoutInput } from "./settings-utils";

export function AgentSection({
  config,
  onOpenSystemPromptFile,
  update,
}: {
  config: AethonConfig;
  onOpenSystemPromptFile: () => void;
  update: SettingsUpdate;
}) {
  return (
    <Section id="agent" title="Agent">
      {/* The default model for new sessions is set directly from
          the header model picker — it persists [agent] model and
          governs every new session. A separate Settings control
          here would edit the same value, so it's intentionally
          omitted. */}
      <Field label="System prompt override">
        <button
          type="button"
          className="ae-settings-secondary"
          onClick={onOpenSystemPromptFile}
          title="Open or create ~/.aethon/system-prompt.md"
        >
          Open system-prompt.md
        </button>
      </Field>
      <Field label="Codex Fast mode (supported GPT-5.5 / GPT-5.4 only)">
        <span className="ae-settings-checkbox-row">
          <input
            type="checkbox"
            checked={config.agent.codexFastMode}
            onChange={(e) =>
              update({
                agent: {
                  ...config.agent,
                  codexFastMode: e.target.checked,
                },
              })
            }
          />
          <span>Use the higher-cost priority service tier when available.</span>
        </span>
      </Field>
      <Field label="Provider request timeout (seconds)">
        <input
          type="number"
          className="ae-settings-input"
          min={0}
          max={MAX_AGENT_TIMEOUT_SECONDS}
          placeholder="Use provider default"
          value={config.agent.providerTimeoutSeconds ?? ""}
          onChange={(e) =>
            update({
              agent: {
                ...config.agent,
                providerTimeoutSeconds:
                  e.target.value === ""
                    ? null
                    : clampTimeoutInput(e.target.value, null),
              },
            })
          }
        />
      </Field>
      <Field label="Bash timeout floor (seconds)">
        <input
          type="number"
          className="ae-settings-input"
          min={1}
          max={MAX_AGENT_TIMEOUT_SECONDS}
          value={config.agent.bashTimeoutFloorSeconds}
          onChange={(e) =>
            update({
              agent: {
                ...config.agent,
                bashTimeoutFloorSeconds:
                  clampTimeoutInput(
                    e.target.value,
                    DEFAULT_AGENT_TIMEOUT_SECONDS,
                  ) ?? DEFAULT_AGENT_TIMEOUT_SECONDS,
              },
            })
          }
        />
      </Field>
      <Field label="Inline subagent timeout (seconds)">
        <input
          type="number"
          className="ae-settings-input"
          min={1}
          max={MAX_AGENT_TIMEOUT_SECONDS}
          value={config.agent.subagentTimeoutSeconds}
          onChange={(e) =>
            update({
              agent: {
                ...config.agent,
                subagentTimeoutSeconds:
                  clampTimeoutInput(
                    e.target.value,
                    DEFAULT_AGENT_TIMEOUT_SECONDS,
                  ) ?? DEFAULT_AGENT_TIMEOUT_SECONDS,
              },
            })
          }
        />
      </Field>
    </Section>
  );
}
