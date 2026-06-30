import { useState } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import type { ChatMessage } from "../../types/a2ui";
import { tabIsRunning } from "./message-row-state";

function tabCwdFromState(
  state: Record<string, unknown>,
  tabId: string | undefined,
): string | undefined {
  if (!tabId || !Array.isArray(state.tabs)) return undefined;
  const tab = state.tabs.find(
    (candidate): candidate is { id: string; cwd?: string } =>
      Boolean(
        candidate &&
        typeof candidate === "object" &&
        "id" in candidate &&
        candidate.id === tabId,
      ),
  );
  return typeof tab?.cwd === "string" ? tab.cwd : undefined;
}

function branchEventPayload(
  target: ChatMessage,
  tabId: string | undefined,
  state: Record<string, unknown>,
) {
  const cwd = target.cwd ?? tabCwdFromState(state, tabId);
  return {
    entryId: target.entryId,
    tabId,
    ...(cwd ? { cwd } : {}),
  };
}

export function TurnBranchActions({
  rollbackTarget,
  forkTarget,
  state,
  tabId,
  onEvent,
}: {
  rollbackTarget?: ChatMessage;
  forkTarget?: ChatMessage;
  state: Record<string, unknown>;
  tabId?: string;
  onEvent?: BuiltinComponentProps["onEvent"];
}) {
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  if ((!rollbackTarget?.entryId && !forkTarget?.entryId) || !onEvent) {
    return null;
  }
  const running = tabIsRunning(state, tabId);
  return (
    <div
      className="ae-turn-branch-actions"
      aria-label="Conversation turn actions"
      onMouseLeave={() => setConfirmingRollback(false)}
    >
      {confirmingRollback && !running && rollbackTarget?.entryId ? (
        <>
          <button
            type="button"
            className="ae-turn-branch-btn ae-turn-branch-confirm"
            onClick={() => {
              setConfirmingRollback(false);
              onEvent(
                "rollback-to-here",
                branchEventPayload(rollbackTarget, tabId, state),
              );
            }}
          >
            Confirm rollback
          </button>
          <button
            type="button"
            className="ae-turn-branch-btn"
            onClick={() => setConfirmingRollback(false)}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          {!running && rollbackTarget?.entryId ? (
            <button
              type="button"
              className="ae-turn-branch-btn"
              aria-label="Rollback this turn"
              title="Rewind the conversation to this prompt"
              onClick={() => setConfirmingRollback(true)}
            >
              <svg
                viewBox="0 0 16 16"
                width="13"
                height="13"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M5.2 5.1H10a4 4 0 1 1-3.1 6.55" />
                <path d="M5.2 5.1 7.55 2.8" />
                <path d="M5.2 5.1 7.55 7.45" />
              </svg>
              <span className="ae-turn-branch-label">Rollback</span>
            </button>
          ) : null}
          {forkTarget?.entryId ? (
            <button
              type="button"
              className="ae-turn-branch-btn"
              aria-label="Fork this turn"
              title="Fork the conversation into a new tab from this turn"
              onClick={() =>
                onEvent(
                  "fork-to-tab",
                  branchEventPayload(forkTarget, tabId, state),
                )
              }
            >
              <svg
                viewBox="0 0 16 16"
                width="13"
                height="13"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M5 3.25v4.15c0 2.4 1.55 4.1 4.2 4.1H11" />
                <path d="M8.75 9.2 11 11.5l-2.25 2.3" />
                <circle cx="5" cy="3.25" r="1.6" />
                <circle cx="5" cy="12.75" r="1.6" />
              </svg>
              <span className="ae-turn-branch-label">Fork</span>
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
