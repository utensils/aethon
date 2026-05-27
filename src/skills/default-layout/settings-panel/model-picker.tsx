// Select-with-custom-fallback model picker. Backed by the live model
// list at `state.sidebar.models` (populated by the bridge's `ready` +
// model_changed events).
//
// Two interaction modes:
//   - Dropdown of the loaded models, plus "Other…" which swaps in a free
//     text input so power users can still type "anthropic/claude-foo".
//   - Custom mode is selected automatically when the saved value
//     doesn't match any loaded model (e.g. user changed their pi config
//     but hasn't relaunched the bridge yet).
//
// Empty value (no entry / null in config) renders the placeholder
// "(pi default)" — the agent picks based on env vars in that case.

import { useEffect, useState } from "react";
import { DropdownPickerCore } from "../variation-components";

interface ModelOption {
  id: string;
  label: string;
}

export function ModelPicker({
  state,
  value,
  onChange,
}: {
  state: Record<string, unknown>;
  value: string;
  onChange: (next: string) => void;
}) {
  // Reuses the same DropdownPickerCore the header model picker renders,
  // so search/filter + keyboard nav + visual style stay in lockstep
  // (replaces a bespoke <select>+custom-mode pair). A sentinel
  // `__pi_default__` id maps back to `""` so "(pi default)" stays
  // selectable; a sentinel `__custom__` id flips into a free-text
  // input for the rare case a user wants a model not on the list.
  const sidebar =
    (state.sidebar as Record<string, unknown> | undefined) ?? {};
  const models =
    ((sidebar.models as ModelOption[] | undefined) ?? []).filter(
      (m) => typeof m.id === "string" && m.id.length > 0,
    );
  const trimmed = value.trim();
  const knownIds = new Set(models.map((m) => m.id));
  const startsCustom = trimmed.length > 0 && !knownIds.has(trimmed);
  const [customMode, setCustomMode] = useState(startsCustom);
  // Re-flip when the value or model list changes (e.g. an extension
  // registers a new model). Derived-state resync from external input.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived-state resync on external input change
    setCustomMode(startsCustom);
  }, [startsCustom]);

  if (customMode) {
    return (
      <span className="ae-settings-model-picker">
        <input
          type="text"
          className="ae-settings-input"
          placeholder="anthropic/claude-sonnet-4-6"
          value={trimmed}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Custom model id"
        />
        <button
          type="button"
          className="ae-settings-secondary ae-settings-model-picker-toggle"
          onClick={() => {
            setCustomMode(false);
            onChange("");
          }}
          title="Pick from the loaded model list"
        >
          List
        </button>
      </span>
    );
  }

  const PI_DEFAULT = "__pi_default__";
  const CUSTOM = "__custom__";
  const activeMatch = knownIds.has(trimmed) ? trimmed : PI_DEFAULT;
  const items = [
    { id: PI_DEFAULT, label: "(pi default — picks from env vars)", active: activeMatch === PI_DEFAULT },
    ...models.map((m) => ({
      id: m.id,
      label: m.label || m.id,
      hint: m.label && m.label !== m.id ? m.id : undefined,
      active: activeMatch === m.id,
    })),
    { id: CUSTOM, label: "Custom id…" },
  ];
  const activeItem = items.find((it) => it.active);
  const buttonLabel = activeItem?.label || "(pi default)";

  return (
    <span className="ae-settings-model-picker">
      <DropdownPickerCore
        className="a2ui-model-picker ae-settings-model-picker-dropdown"
        buttonLabel={buttonLabel}
        align="left"
        sections={[
          {
            id: "models",
            title: "models",
            items,
            searchable: true,
            searchPlaceholder: "filter models — sonnet, gpt, qwen…",
            emptyLabel: "no models match",
          },
        ]}
        onSelect={(_sectionId, itemId) => {
          if (itemId === CUSTOM) {
            setCustomMode(true);
            return;
          }
          onChange(itemId === PI_DEFAULT ? "" : itemId);
        }}
      />
    </span>
  );
}
