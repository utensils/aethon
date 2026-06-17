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

export interface SubagentProgressBatch {
  kind: "batch";
  order: string[];
  items: Record<string, SubagentProgress>;
}

export type SubagentProgressEntry = SubagentProgress | SubagentProgressBatch;

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

function emptyProgress(subagent: string, model: string): SubagentProgress {
  return {
    subagent,
    model,
    steps: [],
    text: "",
    done: false,
  };
}

function applyProgressPhase(
  cur: SubagentProgress,
  data: Record<string, unknown>,
): SubagentProgress {
  const phase = str(data.phase);
  const next: SubagentProgress = {
    ...cur,
    subagent: str(data.subagent) || cur.subagent,
    model: str(data.model) || cur.model,
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
  return next;
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
  const subagent = str(data.subagent);
  const model = str(data.model);
  const batchItemId = str(data.batchItemId);

  ctx.setState((prev) => {
    const map =
      (prev.subagentProgress as
        | Record<string, SubagentProgressEntry>
        | undefined) ??
      {};
    if (batchItemId) {
      const curEntry = map[parentCallId];
      const curBatch: SubagentProgressBatch =
        curEntry && "kind" in curEntry && curEntry.kind === "batch"
          ? curEntry
          : { kind: "batch", order: [], items: {} };
      const curItem =
        curBatch.items[batchItemId] ?? emptyProgress(subagent, model);
      const nextItem = applyProgressPhase(curItem, data);
      const order = curBatch.order.includes(batchItemId)
        ? curBatch.order
        : [...curBatch.order, batchItemId].sort((a, b) => {
            const ai = Number(a.split(":", 1)[0]);
            const bi = Number(b.split(":", 1)[0]);
            if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
            return a.localeCompare(b);
          });
      return {
        ...prev,
        subagentProgress: {
          ...map,
          [parentCallId]: {
            kind: "batch",
            order,
            items: { ...curBatch.items, [batchItemId]: nextItem },
          },
        },
      };
    }
    const curEntry = map[parentCallId];
    const cur =
      curEntry && !("kind" in curEntry)
        ? curEntry
        : emptyProgress(subagent, model);
    const next = applyProgressPhase(cur, data);
    return { ...prev, subagentProgress: { ...map, [parentCallId]: next } };
  });
};
