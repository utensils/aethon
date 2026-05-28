// Extensions sub-list rendered inside the Settings panel. Reads from
// `state.sidebar.extensions` (the same source the sidebar's Extensions
// section uses, so toggling here and there stay in sync).

import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { ToggleSwitch } from "../toggle-switch";

interface ExtensionItem {
  id: string;
  label: string;
  hint?: string;
  active?: boolean;
}

export function ExtensionsList({
  state,
  onEvent,
}: {
  state: Record<string, unknown>;
  onEvent: BuiltinComponentProps["onEvent"];
}) {
  const sidebar = (state.sidebar as Record<string, unknown> | undefined) ?? {};
  const items = (sidebar.extensions as ExtensionItem[] | undefined) ?? [];
  if (items.length === 0) {
    return (
      <p className="ae-settings-note">
        No user or project extensions loaded. Drop a <code>.mjs</code> into{" "}
        <code>~/.aethon/extensions/</code> or the active project's{" "}
        <code>.aethon/extensions/</code> directory to register one.
      </p>
    );
  }
  return (
    <ul className="ae-settings-ext-list">
      {items.map((item) => {
        const kind = item.id.startsWith("ext:")
          ? "enabled"
          : item.id.startsWith("ext-failed:")
            ? "failed"
            : item.id.startsWith("ext-disabled:")
              ? "disabled"
              : "core";
        const name =
          kind === "enabled"
            ? item.id.slice("ext:".length)
            : kind === "failed"
              ? item.id.slice("ext-failed:".length)
              : kind === "disabled"
                ? item.id.slice("ext-disabled:".length)
                : item.label;
        const canToggle = kind !== "core";
        return (
          <li
            key={item.id}
            className={`ae-settings-ext-row ae-settings-ext-row--${kind}`}
          >
            <span className="ae-settings-ext-name">{item.label}</span>
            {item.hint ? (
              <span className="ae-settings-ext-hint">{item.hint}</span>
            ) : null}
            {canToggle ? (
              <ToggleSwitch
                checked={kind === "enabled"}
                disabled={kind === "failed"}
                // Pick the verb from the actual checked state (not just
                // the explicit "disabled" branch) — otherwise a failed
                // extension renders unchecked but announces "Disable
                // extension X" to assistive tech. Matches the sidebar
                // toggle which keys off `extState.checked` for the
                // same reason.
                ariaLabel={`${kind === "enabled" ? "Disable" : "Enable"} extension ${name}`}
                title={
                  kind === "failed"
                    ? "Extension failed to load — fix the error and reload to re-enable"
                    : kind === "disabled"
                      ? `Enable ${name}`
                      : `Disable ${name}`
                }
                onChange={(next) => {
                  onEvent("toggle-extension", {
                    sectionId: "extensions",
                    itemId: item.id,
                    name,
                    disabled: !next,
                  });
                }}
              />
            ) : (
              <span
                className="ae-settings-ext-hint"
                title="Built-in core extension"
              >
                core
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
