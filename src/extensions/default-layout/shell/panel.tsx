/**
 * TerminalPanel — tabbed bottom-of-screen terminal area (M6 restructure).
 *
 * Replaces the standalone Terminal composite in the workstation layout's
 * `terminal` cell. The panel hosts:
 *   - One "Agent bash" sub-tab (read-only sink for the agent's bash-tool
 *     output). Hidden when the overview pseudo-tab owns the canvas — the
 *     agent isn't running so the read-only stream has nothing to show
 *     and would just clutter the strip. Returns when the user activates
 *     a real agent session.
 *   - Zero or more user shell sub-tabs (interactive PTYs spawned via
 *     `Cmd+T` while focus is in the panel, or `Cmd+Shift+T` regardless).
 *
 * Active sub-tab is tracked at `/terminalPanel/activeSubId`, defaulting to
 * "agent-bash" when an agent session is live, otherwise the first shell.
 * Switching sub-tabs unmounts/remounts the inner xterm so per-sub-tab
 * scrollback isolation is automatic.
 */

import { useMemo, useRef } from "react";
import type {
  BooleanValue,
  NumberValue,
} from "../../../types/a2ui";
import { resolveBoolean } from "../../../utils/dataBinding";
import { activeTabKind, type Tab } from "../../../types/tab";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { Terminal } from "../terminal";
import { ShellCanvas } from "./canvas";
import { AGENT_BASH_SUB_ID, resolveActiveSubId } from "./panel-helpers";

const TERMINAL_PANEL_MIN_HEIGHT = 120;
const TERMINAL_PANEL_MAX_HEIGHT = 720;

interface ShellSubTabItem {
  id: string;
  label: string;
  shellState?: string;
}

export function TerminalPanel({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    visible?: BooleanValue;
    fontSize?: NumberValue;
  };
  const visible = props.visible ? resolveBoolean(props.visible, state) : true;

  // Pull shell sub-tabs out of the unified /tabs list. Shells live in
  // /tabs (same as agent tabs) but render in this panel rather than the
  // top tab strip — the TabStrip composite filters them out.
  const rawTabs = state["tabs"] as Tab[] | undefined;
  const tabs = useMemo(() => rawTabs ?? [], [rawTabs]);
  const shellTabs: ShellSubTabItem[] = useMemo(
    () =>
      tabs
        .filter((t) => t.kind === "shell")
        .map((t) => ({
          id: t.id,
          label: t.label,
          shellState: t.shell?.shellState,
        })),
    [tabs],
  );

  // Active sub-tab id. Held under /terminalPanel/activeSubId so it
  // persists across renders and can be addressed via $ref. The overview
  // pseudo-tab hides the agent-bash sub-tab (no agent session is
  // running) — fall through to the first interactive shell instead.
  const panelState =
    (state["terminalPanel"] as { activeSubId?: string; height?: number } | undefined) ?? {};
  const showAgentBash =
    activeTabKind(tabs, state["activeTabId"] as string | undefined) ===
    "agent";
  const requestedActiveId = panelState.activeSubId ?? AGENT_BASH_SUB_ID;
  const panelRef = useRef<HTMLDivElement>(null);
  // Resolve via the shared helper so the focus-aware Cmd+W path in
  // useKeyboardShortcuts sees the same active sub-tab the user does.
  const activeSubId = useMemo<string | null>(
    () =>
      resolveActiveSubId({
        requestedActiveId,
        shellTabIds: shellTabs.map((s) => s.id),
        showAgentBash,
      }),
    [requestedActiveId, shellTabs, showAgentBash],
  );

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const startY = e.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    document.body.classList.add("ae-resizing-terminal");
    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY;
      const next = Math.max(
        TERMINAL_PANEL_MIN_HEIGHT,
        Math.min(TERMINAL_PANEL_MAX_HEIGHT, Math.round(startHeight + dy)),
      );
      onEvent("resize", { height: next });
    };
    const onUp = () => {
      document.body.classList.remove("ae-resizing-terminal");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      onEvent("resize-end");
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      ref={panelRef}
      className={
        visible ? "ae-terminal-panel" : "ae-terminal-panel is-closed"
      }
      aria-hidden={!visible}
      style={{ gridArea: "terminal", height: "100%" }}
    >
      <div
        className="ae-terminal-panel-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel"
        onMouseDown={onResizeStart}
      />
      <div className="ae-terminal-panel-tabs" role="tablist">
        {showAgentBash && (
          <SubTabPill
            id={AGENT_BASH_SUB_ID}
            label="Agent bash"
            hint="read-only"
            active={activeSubId === AGENT_BASH_SUB_ID}
            onSelect={() =>
              onEvent("select-sub-tab", { subTabId: AGENT_BASH_SUB_ID })
            }
          />
        )}
        {shellTabs.map((s, i) => (
          <SubTabPill
            key={s.id}
            id={s.id}
            label={s.label || `Shell ${i + 1}`}
            hint={s.shellState === "exited" ? "exited" : undefined}
            active={activeSubId === s.id}
            closable
            onSelect={() => onEvent("select-sub-tab", { subTabId: s.id })}
            onClose={() => onEvent("close-sub-tab", { subTabId: s.id })}
          />
        ))}
        <button
          type="button"
          className="ae-terminal-panel-new"
          aria-label="New shell"
          title="New shell tab (⌘T while focused here)"
          onClick={() => onEvent("new-shell-sub-tab")}
        >
          +
        </button>
      </div>
      <div className="ae-terminal-panel-body">
        {activeSubId === AGENT_BASH_SUB_ID ? (
          <Terminal
            component={{
              id: `${component.id}-agent-bash`,
              type: "terminal",
              props: {
                fontSize: props.fontSize ?? 13,
                subscribeToBash: true,
                readOnly: true,
              },
            }}
            state={state}
            onEvent={onEvent}
          />
        ) : activeSubId ? (
          <ShellCanvas
            component={{
              id: `${component.id}-shell-${activeSubId}`,
              type: "shell-canvas",
              props: {
                tabId: activeSubId,
                fontSize: props.fontSize ?? 13,
              },
            }}
            state={state}
            onEvent={onEvent}
          />
        ) : (
          <div className="ae-terminal-panel-empty" role="status">
            No shell open. Press <kbd>⌘⇧T</kbd> or <kbd>+</kbd> to start one.
          </div>
        )}
      </div>
    </div>
  );
}

function SubTabPill(props: {
  id: string;
  label: string;
  hint?: string;
  active: boolean;
  closable?: boolean;
  onSelect: () => void;
  onClose?: () => void;
}) {
  const { label, hint, active, closable, onSelect, onClose } = props;
  return (
    <div
      role="tab"
      aria-selected={active}
      className={
        active ? "ae-sub-tab ae-sub-tab-active" : "ae-sub-tab"
      }
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest(".ae-sub-tab-close")) return;
        e.preventDefault();
        onSelect();
      }}
    >
      <span className="ae-sub-tab-label">{label}</span>
      {hint && <span className="ae-sub-tab-hint">{hint}</span>}
      {closable && (
        <button
          type="button"
          className="ae-sub-tab-close"
          aria-label={`Close ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose?.();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
