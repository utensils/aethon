/**
 * Wire types for the voice-brain bridge protocol.
 *
 * Inbound (frontend → global bridge): `voice_turn`, `voice_task_event`,
 * `voice_brain_abort`, `voice_session_reset`. Outbound: `voice_brain_delta`,
 * `voice_brain_end`, `voice_brain_error`.
 *
 * These message types are deliberately NOT in the Rust router's tab-scoped
 * list, so they always reach the global bridge (a worker respawn/retire must
 * never take the brain session with it). Tab references ride as
 * `activeTabId` / `taskTabId` — never a top-level `tabId`.
 */

export interface VoiceTurnContext {
  /** Tab the user is looking at (dispatch defaults to its project). */
  activeTabId?: string;
  /** Active project root — required for dispatch_task. */
  projectPath?: string;
  /** Provider-qualified model dispatched work agents must use. */
  defaultModel?: string;
  /** Optional dedicated brain model (`[voice] brain_model`); empty inherits
   *  the default tab's model. */
  brainModel?: string;
}

export interface VoiceTurnMessage {
  type: "voice_turn";
  text: string;
  context?: VoiceTurnContext;
}

export interface VoiceTaskEventMessage {
  type: "voice_task_event";
  taskTabId: string;
  label?: string;
  status: "completed" | "error";
  /** Work agent's final prose (frontend strips code fences + caps length;
   *  the cap here is a defensive re-check). */
  finalText: string;
}

/** Defensive ceiling on work-agent text entering the brain's context. */
export const VOICE_TASK_EVENT_TEXT_CAP = 4_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function parseVoiceTurn(msg: unknown): VoiceTurnMessage | null {
  const rec = asRecord(msg);
  if (!rec || rec.type !== "voice_turn" || typeof rec.text !== "string") {
    return null;
  }
  const text = rec.text.trim();
  if (!text) return null;
  const ctx = asRecord(rec.context);
  const context: VoiceTurnContext = {};
  if (ctx) {
    for (const key of [
      "activeTabId",
      "projectPath",
      "defaultModel",
      "brainModel",
    ] as const) {
      const value = ctx[key];
      if (typeof value === "string" && value.trim()) {
        context[key] = value.trim();
      }
    }
  }
  return { type: "voice_turn", text, context };
}

export function parseVoiceTaskEvent(msg: unknown): VoiceTaskEventMessage | null {
  const rec = asRecord(msg);
  if (!rec || rec.type !== "voice_task_event") return null;
  if (typeof rec.taskTabId !== "string" || !rec.taskTabId) return null;
  const status = rec.status === "error" ? "error" : "completed";
  const finalText =
    typeof rec.finalText === "string"
      ? rec.finalText.slice(0, VOICE_TASK_EVENT_TEXT_CAP)
      : "";
  return {
    type: "voice_task_event",
    taskTabId: rec.taskTabId,
    ...(typeof rec.label === "string" && rec.label ? { label: rec.label } : {}),
    status,
    finalText,
  };
}
