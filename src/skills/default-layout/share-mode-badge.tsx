// Shell tab share-mode badge — clickable label that cycles
// private → read → read-write → read-write-trusted → private.
// Registered as `share-mode-badge` on `defaultLayoutSkill` so a skill can
// override it via `aethon.registerComponent("share-mode-badge", custom)`.
//
// Reads `shareMode` + `tabId` from props.{shareMode,tabId} (preferred when
// hosted by `ShellStatusBar`, which forwards them as direct props) or
// falls back to the active shell tab's `/tabs[active].shell.shareMode`
// when mounted standalone (e.g. from a custom layout slot).
//
// Cycle behavior — and the security implications of each mode — live in
// `src/utils/shareMode.ts`. The bridge enforces the privacy floor in
// `shell.rs`; this component is purely the visible affordance.

import { useMemo } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import type { ShareMode } from "../../utils/shareMode";
import { shareModeLabel, shareModeTooltip } from "../../utils/shareMode";

interface BadgeProps {
  shareMode: ShareMode;
  tabId?: string;
}

function readBadgeProps(
  component: BuiltinComponentProps["component"],
  state: Record<string, unknown>,
): BadgeProps {
  const props = (component.props ?? {}) as Partial<BadgeProps>;
  if (props.shareMode) {
    return { shareMode: props.shareMode, tabId: props.tabId };
  }
  // Fallback path — caller didn't pass a mode, so derive from the active
  // shell tab. Lets a skill drop `<share-mode-badge>` into any layout cell
  // without wiring shareMode through state-binding.
  const tabs = (state.tabs as Array<{
    id: string;
    kind?: string;
    shell?: { shareMode?: ShareMode };
  }>) ?? [];
  const activeId = state.activeTabId as string | undefined;
  const tab = activeId ? tabs.find((t) => t.id === activeId) : undefined;
  if (tab?.kind !== "shell") return { shareMode: "private", tabId: activeId };
  return {
    shareMode: tab.shell?.shareMode ?? "private",
    tabId: tab.id,
  };
}

export function ShareModeBadge({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const { shareMode, tabId } = readBadgeProps(component, state);
  const label = useMemo(() => shareModeLabel(shareMode), [shareMode]);
  const tooltip = useMemo(() => shareModeTooltip(shareMode), [shareMode]);
  return (
    <button
      type="button"
      className="ae-share-badge"
      data-mode={shareMode}
      title={tooltip}
      aria-label={`Share mode: ${label}. ${tooltip}`}
      onClick={() => {
        if (!tabId) return;
        onEvent("cycle-share-mode", { tabId });
      }}
    >
      {label}
    </button>
  );
}
