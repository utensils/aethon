import type { BridgeMessageHandler } from "./types";

/** Accumulated live progress for one `task` delegation, keyed by the parent
 *  tool-call id. Read by the tool-card to render a nested activity timeline. */
export interface SubagentProgress {
  subagent: string;
  model: string;
  steps: { kind: "tool" | "error"; label: string }[];
  text: string;
  done: boolean;
}

const MAX_TEXT = 4000;
const MAX_STEPS = 60;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toolLabel(data: Record<string, unknown>): string {
  const name = str(data.toolName) || "tool";
  const summary = str(data.toolSummary);
  return summary ? `${name} ${summary}` : name;
}

/**
 * Translate a subagent_progress event (emitted by the `task` tool while a
 * subagent runs inline) into the `/subagentProgress/<parentCallId>` state slice.
 * The outer tool card already streams the subagent's text via pi's partial
 * results; this drives the richer nested timeline (per-tool steps).
 */
export const handleSubagentProgress: BridgeMessageHandler = (data, ctx) => {
  const parentCallId = str(data.parentCallId);
  if (!parentCallId) return;
  const phase = str(data.phase);
  const subagent = str(data.subagent);
  const model = str(data.model);

  ctx.setState((prev) => {
    const map =
      (prev.subagentProgress as Record<string, SubagentProgress> | undefined) ??
      {};
    const cur: SubagentProgress = map[parentCallId] ?? {
      subagent,
      model,
      steps: [],
      text: "",
      done: false,
    };
    const next: SubagentProgress = {
      ...cur,
      subagent: subagent || cur.subagent,
      model: model || cur.model,
    };
    switch (phase) {
      case "text":
        next.text = (cur.text + str(data.delta)).slice(-MAX_TEXT);
        break;
      case "tool_start":
        next.steps = [
          ...cur.steps,
          { kind: "tool" as const, label: toolLabel(data) },
        ].slice(-MAX_STEPS);
        break;
      case "error":
        next.steps = [
          ...cur.steps,
          { kind: "error" as const, label: str(data.error) || "error" },
        ].slice(-MAX_STEPS);
        break;
      case "done":
        next.done = true;
        break;
      default:
        break;
    }
    return { ...prev, subagentProgress: { ...map, [parentCallId]: next } };
  });
};
