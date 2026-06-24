import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { ChatMessage } from "../types/a2ui";
import type { Tab } from "../types/tab";
import { clearConfigCache } from "../config";
import { writeConfigPatch } from "../configWrites";
import {
  recomputeModelPicker,
  PI_DEFAULT_MODEL_SENTINEL,
} from "../utils/modelPicker";
import { isAgentTabInFlight } from "../utils/agentBusy";
import type { UseChatContext } from "./useChat";

export const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export function parseModelIdWithThinking(raw: string): {
  modelId: string;
  thinkingLevel?: string;
} {
  const idx = raw.lastIndexOf(":");
  if (idx <= 0) return { modelId: raw };
  const modelId = raw.slice(0, idx);
  const suffix = raw.slice(idx + 1);
  if (!modelId.startsWith("openai-codex/") || !THINKING_LEVELS.has(suffix)) {
    return { modelId: raw };
  }
  return { modelId, thinkingLevel: suffix };
}

function workspaceLandingVisible(state: Record<string, unknown>): boolean {
  return (
    (state.landing as { kind?: string } | null | undefined)?.kind ===
    "workspace"
  );
}

export interface ChatModelSelectionDeps {
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
}

export interface ChatModelSelectionController {
  setModel: (id: string) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  setCodexFastMode: (enabled: boolean) => Promise<void>;
}

export function useChatModelSelectionController(
  ctx: Pick<
    UseChatContext,
    | "setState"
    | "stateRef"
    | "updateTab"
    | "recordProjectModel"
    | "piDefaultModelRef"
  >,
  deps: ChatModelSelectionDeps,
): ChatModelSelectionController {
  const {
    setState,
    stateRef,
    updateTab,
    recordProjectModel,
    piDefaultModelRef,
  } = ctx;
  const { appendMessage } = deps;

  // Debounced persistence of header-selected agent defaults to [agent].
  // Clicking through models / reasoning levels would otherwise do a disk read +
  // full TOML rewrite per click; coalesce to a single trailing write.
  const agentDefaultsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingAgentDefaultsRef = useRef<
    Partial<{ model: string | null; thinkingLevel: string | null }>
  >({});

  async function flushAgentDefaultsWrite() {
    const patch = pendingAgentDefaultsRef.current;
    if (Object.keys(patch).length === 0) return;
    pendingAgentDefaultsRef.current = {};
    try {
      await writeConfigPatch({ agent: patch });
      // Drop the read-once cache so an open Settings panel + the next
      // getConfig() reflect the header-chosen defaults.
      clearConfigCache();
    } catch (err) {
      console.warn("persist agent defaults failed:", err);
    }
  }

  function persistAgentDefaults(
    patch: Partial<{ model: string | null; thinkingLevel: string | null }>,
  ) {
    pendingAgentDefaultsRef.current = {
      ...pendingAgentDefaultsRef.current,
      ...patch,
    };
    if (agentDefaultsTimerRef.current) {
      clearTimeout(agentDefaultsTimerRef.current);
    }
    agentDefaultsTimerRef.current = setTimeout(() => {
      agentDefaultsTimerRef.current = null;
      void flushAgentDefaultsWrite();
    }, 400);
  }

  function persistDefaultModel(model: string) {
    persistAgentDefaults({ model: model || null });
  }

  function persistDefaultThinkingLevel(level: string) {
    persistAgentDefaults({ thinkingLevel: level || null });
  }

  /** Header / Settings model pick. Two responsibilities:
   *
   *  1. Set the user's default model for *new* sessions — `/defaultModel`,
   *     persisted to `[agent] model`. This always sticks; it is intent,
   *     independent of whether a live session accepts the switch, and wins
   *     over per-project memory in `modelForNewProjectTab`.
   *  2. Retarget the *active* session (when one is focused) via `set_model`.
   *
   *  With no active agent tab (e.g. on the dashboard) we skip the bridge
   *  call entirely — there is nothing to switch and invoking `set_model`
   *  would spin up a phantom "default" session — but the default pick above
   *  is enough for the next new session to inherit. */
  async function setModel(id: string) {
    // "(pi default)" — fully reset to pi's env-driven default for new
    // sessions. Clear every runtime fallback so the next new tab sends
    // NO explicit model and the agent picks from env: the chosen default
    // (/defaultModel), per-project memory (/projectModels), and pi's
    // cached boot model (/piDefaultModel + piDefaultModelRef — which may
    // itself be a stale configured value seeded at boot). Persist
    // [agent] model = null. Does not retarget a running session — the
    // reset governs new sessions only, matching the old Settings field.
    if (id === PI_DEFAULT_MODEL_SENTINEL) {
      const activeId = stateRef.current.activeTabId as string | undefined;
      const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
      const activeTab = activeId
        ? tabs.find((t) => t.id === activeId)
        : undefined;
      const hasActiveAgentTab =
        activeTab?.kind === "agent" &&
        !workspaceLandingVisible(stateRef.current);
      piDefaultModelRef.current = "";
      setState((prev) => ({
        ...prev,
        defaultModel: "",
        piDefaultModel: "",
        projectModels: {},
        // Blank the header display when no agent tab owns it so the picker
        // shows "(pi default)"; a focused session keeps its own model.
        ...(hasActiveAgentTab ? {} : { model: "" }),
        sidebar: recomputeModelPicker(
          prev.sidebar as Record<string, unknown> | undefined,
          hasActiveAgentTab ? (activeTab?.model ?? "") : "",
        ),
      }));
      persistDefaultModel(""); // writes [agent] model = null
      return;
    }
    const parsed = parseModelIdWithThinking(id.trim());
    const trimmed = parsed.modelId;
    if (!trimmed) return;
    const activeId = stateRef.current.activeTabId as string | undefined;
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const activeTab = activeId
      ? tabs.find((t) => t.id === activeId)
      : undefined;
    const hasActiveAgentTab =
      activeTab?.kind === "agent" && !workspaceLandingVisible(stateRef.current);
    const previousTabModel = activeTab?.model ?? "";
    // Only mirror onto a live session when an agent tab is focused and not
    // mid-turn (the bridge rejects a switch while a prompt is in flight).
    const canMirror =
      hasActiveAgentTab &&
      stateRef.current.waiting !== true &&
      !isAgentTabInFlight(activeTab);

    recordProjectModel(trimmed, activeId);
    setState((prev) => ({
      ...prev,
      defaultModel: trimmed,
      ...(parsed.thinkingLevel
        ? {
            thinkingLevel: parsed.thinkingLevel,
            defaultThinkingLevel: parsed.thinkingLevel,
          }
        : {}),
      // Mirror onto /model for the header display when we're switching a
      // live session OR when no agent tab owns the header (dashboard /
      // shell focus) so the picker reflects the chosen default. When an
      // agent tab is busy we leave /model alone — the switch is deferred.
      ...(canMirror || !hasActiveAgentTab ? { model: trimmed } : {}),
      ...(canMirror ? { status: `switching to ${trimmed}...` } : {}),
      sidebar: recomputeModelPicker(
        prev.sidebar as Record<string, unknown> | undefined,
        trimmed,
      ),
    }));
    if (canMirror && activeId) {
      updateTab(activeId, (tab) => ({ ...tab, model: trimmed }));
    }
    persistDefaultModel(trimmed);
    if (parsed.thinkingLevel) {
      persistDefaultThinkingLevel(parsed.thinkingLevel);
    }

    // No live session to retarget — the default pick is all that's needed.
    if (!hasActiveAgentTab || !activeId) return;
    try {
      await invoke("agent_command", {
        payload: JSON.stringify({
          type: "set_model",
          id: trimmed,
          tabId: activeId,
          ...(parsed.thinkingLevel
            ? { thinkingLevel: parsed.thinkingLevel }
            : {}),
        }),
      });
    } catch (err) {
      // Roll back ONLY the optimistic live-session mirror — the chosen
      // default (/defaultModel + persisted config) is intent and stays.
      if (canMirror && previousTabModel) {
        updateTab(activeId, (tab) => ({ ...tab, model: previousTabModel }));
        setState((prev) => ({
          ...prev,
          model: previousTabModel,
          status: "model switch failed",
        }));
      }
      appendMessage(
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Failed to switch model: ${err}`,
        },
        activeId,
      );
    }
  }

  async function setThinkingLevel(level: string) {
    const activeId = stateRef.current.activeTabId as string | undefined;
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const activeTab = activeId
      ? tabs.find((t) => t.id === activeId)
      : undefined;
    if (
      !activeId ||
      (activeTab?.kind ?? "agent") !== "agent" ||
      workspaceLandingVisible(stateRef.current)
    ) {
      setState((prev) => ({
        ...prev,
        thinkingLevel: level,
        defaultThinkingLevel: level,
        status: `reasoning default: ${level}`,
      }));
      persistDefaultThinkingLevel(level);
      return;
    }
    if (stateRef.current.waiting === true || isAgentTabInFlight(activeTab)) {
      setState((prev) => ({
        ...prev,
        status:
          "agent busy — stop the current prompt before switching reasoning",
      }));
      return;
    }
    const previousTabThinkingLevel = activeTab?.thinkingLevel;
    const previousThinkingLevel =
      typeof stateRef.current.thinkingLevel === "string"
        ? stateRef.current.thinkingLevel
        : undefined;
    updateTab(activeId, (tab) => ({ ...tab, thinkingLevel: level }));
    setState((prev) => ({
      ...prev,
      thinkingLevel: level,
      defaultThinkingLevel: level,
      status: `reasoning: ${level}`,
    }));
    persistDefaultThinkingLevel(level);
    try {
      await invoke("agent_command", {
        payload: JSON.stringify({
          type: "set_thinking_level",
          tabId: activeId,
          thinkingLevel: level,
        }),
      });
    } catch (err) {
      updateTab(activeId, (tab) => {
        const next = { ...tab };
        if (previousTabThinkingLevel) {
          next.thinkingLevel = previousTabThinkingLevel;
        } else {
          delete next.thinkingLevel;
        }
        return next;
      });
      setState((prev) => {
        const next: Record<string, unknown> = {
          ...prev,
          status: "reasoning switch failed",
        };
        if (previousThinkingLevel) {
          next.thinkingLevel = previousThinkingLevel;
        } else {
          delete next.thinkingLevel;
        }
        // Keep defaultThinkingLevel as the user's new-session default; only
        // the active live-session mirror rolls back on bridge failure.
        return next;
      });
      appendMessage(
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Failed to switch reasoning: ${err}`,
        },
        activeId,
      );
    }
  }

  async function setCodexFastMode(enabled: boolean) {
    const previousCodexFastMode = stateRef.current.codexFastMode === true;
    setState((prev) => ({ ...prev, codexFastMode: enabled }));
    try {
      await writeConfigPatch({ agent: { codexFastMode: enabled } });
      clearConfigCache();
      await invoke("agent_broadcast_command", {
        payload: JSON.stringify({
          type: "set_codex_fast_mode",
          codexFastMode: enabled,
        }),
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        codexFastMode: previousCodexFastMode,
        status: "Codex Fast mode update failed",
      }));
      appendMessage({
        id: crypto.randomUUID(),
        role: "agent",
        text: `Failed to update Codex Fast mode: ${err}`,
      });
    }
  }

  return { setModel, setThinkingLevel, setCodexFastMode };
}
