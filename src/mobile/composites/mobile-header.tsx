import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import {
  AgentStatusPill,
  ModelPicker,
} from "../../extensions/default-layout/variation-components";
import { ConnectionBadge } from "./connection-badge";

interface TabLike {
  id?: string;
  kind?: string;
}

function hasProjectContext(state: Record<string, unknown>): boolean {
  const project = state.project as { id?: unknown; path?: unknown } | null | undefined;
  return (
    typeof state.activeProjectId === "string" ||
    typeof project?.id === "string" ||
    typeof project?.path === "string"
  );
}

function hasSessionContext(state: Record<string, unknown>): boolean {
  const tabs = (Array.isArray(state.tabs) ? state.tabs : []) as TabLike[];
  const activeTabId =
    typeof state.activeTabId === "string" ? state.activeTabId : undefined;
  return tabs.some(
    (tab) => (tab.kind ?? "agent") === "agent" && (!activeTabId || tab.id === activeTabId),
  );
}

export function MobileHeader(props: BuiltinComponentProps) {
  const showModelControls =
    hasProjectContext(props.state) || hasSessionContext(props.state);

  return (
    <header className="ae-mobile-header">
      {showModelControls ? (
        <AgentStatusPill
          {...props}
          component={{
            id: "mobile-pill",
            type: "agent-pulse",
            props: {
              label: { $ref: "/agentStatus/label" },
              state: { $ref: "/agentStatus/state" },
            },
          }}
        />
      ) : null}
      <span className="ae-header-spacer" aria-hidden />
      {showModelControls ? (
        <ModelPicker
          {...props}
          component={{ id: "mobile-model", type: "model-picker", props: {} }}
        />
      ) : null}
      <ConnectionBadge />
    </header>
  );
}
