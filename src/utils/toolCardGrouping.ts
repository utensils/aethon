import type { ChatMessage } from "../types/a2ui";
import type { VisibilityMode } from "../config";

/**
 * A render unit for the transcript: either a normal message rendered on its
 * own row, or a collapsible cluster of consecutive completed tool-call cards
 * (produced only in `collapse` mode).
 */
export type MessageGroup =
  | { type: "single"; message: ChatMessage }
  | { type: "tool-group"; id: string; messages: ChatMessage[] };

/** True when a message's A2UI payload is a tool-call card. */
export function isToolCardMessage(m: ChatMessage): boolean {
  const components = m.a2ui?.components;
  return (
    Array.isArray(components) && components.some((c) => c?.type === "tool-card")
  );
}

function toolCardProps(m: ChatMessage): Record<string, unknown> | undefined {
  const comp = m.a2ui?.components?.find((c) => c?.type === "tool-card");
  return comp?.props;
}

/** A tool card that started but hasn't ended is still streaming — keep it
 *  visible (ungrouped) so the user can watch live progress even in collapse
 *  mode. Mirrors ToolCard's own `running` derivation. */
export function isRunningToolCard(m: ChatMessage): boolean {
  const props = toolCardProps(m);
  return (
    !!props && props.startedAt !== undefined && props.endedAt === undefined
  );
}

/**
 * Transform the flat message list into render groups according to the
 * tool-call visibility mode:
 *   - `show`     → one single per message (current behaviour).
 *   - `hide`     → tool-card messages dropped entirely.
 *   - `collapse` → runs of ≥2 consecutive *completed* tool-card messages fold
 *                  into one collapsible cluster; a lone card or a running card
 *                  stays a single so live progress and one-offs read normally.
 *
 * Pure + order-preserving so it's safe to memoize and easy to test.
 */
export function groupMessages(
  messages: ChatMessage[],
  mode: VisibilityMode,
): MessageGroup[] {
  if (mode === "show") {
    return messages.map((message) => ({ type: "single", message }));
  }
  if (mode === "hide") {
    return messages
      .filter((m) => !isToolCardMessage(m))
      .map((message) => ({ type: "single", message }));
  }

  // collapse
  const out: MessageGroup[] = [];
  let batch: ChatMessage[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    if (batch.length === 1) {
      out.push({ type: "single", message: batch[0] });
    } else {
      out.push({ type: "tool-group", id: `toolgroup-${batch[0].id}`, messages: batch });
    }
    batch = [];
  };
  for (const message of messages) {
    if (isToolCardMessage(message) && !isRunningToolCard(message)) {
      batch.push(message);
    } else {
      flush();
      out.push({ type: "single", message });
    }
  }
  flush();
  return out;
}

/** Stable React key for a group. */
export function groupKey(group: MessageGroup): string {
  return group.type === "single" ? group.message.id : group.id;
}
