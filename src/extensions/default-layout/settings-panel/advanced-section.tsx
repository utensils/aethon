import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { Section } from "./sections";

export function AdvancedSection({
  onEvent,
}: {
  onEvent: BuiltinComponentProps["onEvent"];
}) {
  return (
    <Section id="advanced" title="Advanced">
      <p className="ae-settings-note">
        For keys not surfaced here, edit <code>~/.aethon/config.toml</code>{" "}
        directly. Aethon round-trips comments and unknown keys, so hand edits
        survive.
      </p>
      <button
        type="button"
        className="ae-settings-secondary"
        onClick={() => onEvent("reset-layout-prefs")}
      >
        Reset layout
      </button>
      <button
        type="button"
        className="ae-settings-secondary"
        onClick={() => onEvent("open-config-file")}
      >
        Open config.toml
      </button>
    </Section>
  );
}
