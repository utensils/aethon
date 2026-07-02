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
  /** The app's project list (label + root path). Lets the brain dispatch to
   *  a project the user NAMES even when none is active — without this,
   *  "check out claudex" with no active project had no path to dispatch to. */
  knownProjects?: { label: string; path: string }[];
}

/** Ceiling on known-project entries carried per turn (prompt budget). */
export const VOICE_KNOWN_PROJECTS_CAP = 12;

export interface VoiceTurnMessage {
  type: "voice_turn";
  text: string;
  context?: VoiceTurnContext;
}

export interface VoiceTaskEventMessage {
  type: "voice_task_event";
  taskTabId: string;
  label?: string;
  /** `progress` = the task is still running; `finalText` carries a digest of
   *  recent activity rather than a final report. */
  status: "completed" | "error" | "progress";
  /** Work agent's final prose (frontend strips code fences + caps length;
   *  the cap here is a defensive re-check). */
  finalText: string;
  /** Runtime context (brain model, project). Task events are the brain's
   *  primary input — transcripts go straight to the work agent — so the
   *  context has to ride here too. */
  context?: VoiceTurnContext;
}

/** Defensive ceiling on work-agent text entering the brain's context. */
export const VOICE_TASK_EVENT_TEXT_CAP = 4_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function parseTurnContext(raw: unknown): VoiceTurnContext {
  const ctx = asRecord(raw);
  const context: VoiceTurnContext = {};
  if (!ctx) return context;
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
  if (Array.isArray(ctx.knownProjects)) {
    const projects = ctx.knownProjects
      .flatMap((entry) => {
        const rec = asRecord(entry);
        const label = rec?.label;
        const path = rec?.path;
        return typeof label === "string" &&
          label.trim() &&
          typeof path === "string" &&
          path.trim()
          ? [{ label: label.trim(), path: path.trim() }]
          : [];
      })
      .slice(0, VOICE_KNOWN_PROJECTS_CAP);
    if (projects.length > 0) context.knownProjects = projects;
  }
  return context;
}

export function parseVoiceTurn(msg: unknown): VoiceTurnMessage | null {
  const rec = asRecord(msg);
  if (!rec || rec.type !== "voice_turn" || typeof rec.text !== "string") {
    return null;
  }
  const text = rec.text.trim();
  if (!text) return null;
  return { type: "voice_turn", text, context: parseTurnContext(rec.context) };
}

export function parseVoiceTaskEvent(msg: unknown): VoiceTaskEventMessage | null {
  const rec = asRecord(msg);
  if (!rec || rec.type !== "voice_task_event") return null;
  if (typeof rec.taskTabId !== "string" || !rec.taskTabId) return null;
  const status =
    rec.status === "error"
      ? "error"
      : rec.status === "progress"
        ? "progress"
        : "completed";
  const finalText =
    typeof rec.finalText === "string"
      ? rec.finalText.slice(0, VOICE_TASK_EVENT_TEXT_CAP)
      : "";
  const context = parseTurnContext(rec.context);
  return {
    type: "voice_task_event",
    taskTabId: rec.taskTabId,
    ...(typeof rec.label === "string" && rec.label ? { label: rec.label } : {}),
    status,
    finalText,
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
}
