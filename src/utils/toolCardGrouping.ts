import type { ChatMessage } from "../types/a2ui";
import type { ToolCallsMode } from "../config";

/**
 * A render unit for the transcript. One of:
 *   - `single`     — a normal message rendered on its own row;
 *   - `tool-group` — a collapsible cluster of completed tool-call cards
 *                    (produced by `group-run` and `group-turn`);
 *   - `turn-block` — a whole agent turn (narration + tools) folded into one
 *                    collapsible block (produced by `group-block`).
 */
export type MessageGroup =
  | { type: "single"; message: ChatMessage }
  | { type: "tool-group"; id: string; messages: ChatMessage[] }
  | { type: "turn-block"; id: string; messages: ChatMessage[] };

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
 *  visible (ungrouped) so the user can watch live progress even in a grouped
 *  mode. Mirrors ToolCard's own `running` derivation. */
export function isRunningToolCard(m: ChatMessage): boolean {
  const props = toolCardProps(m);
  return (
    !!props && props.startedAt !== undefined && props.endedAt === undefined
  );
}

/** A completed tool card — the unit that grouping consolidates. */
function isCompletedToolCard(m: ChatMessage): boolean {
  return isToolCardMessage(m) && !isRunningToolCard(m);
}

const single = (message: ChatMessage): MessageGroup => ({
  type: "single",
  message,
});

/**
 * Split the flat list into turns. A turn boundary is a `role === "user"`
 * message; everything from one user message up to (but not including) the next
 * starts a new segment. Messages before the first user message form an initial
 * segment. Each returned segment is a contiguous slice in original order.
 */
function segmentByTurn(messages: ChatMessage[]): ChatMessage[][] {
  const segments: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user" && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** `group-run`: runs of ≥2 consecutive *completed* tool cards fold into one
 *  cluster; a lone card or a running card stays a single. This is the exact
 *  behaviour shipped as the original tri-state `collapse`. */
function groupRun(messages: ChatMessage[]): MessageGroup[] {
  const out: MessageGroup[] = [];
  let batch: ChatMessage[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    if (batch.length === 1) {
      out.push(single(batch[0]));
    } else {
      out.push({
        type: "tool-group",
        id: `toolgroup-${batch[0].id}`,
        messages: batch,
      });
    }
    batch = [];
  };
  for (const message of messages) {
    if (isCompletedToolCard(message)) {
      batch.push(message);
    } else {
      flush();
      out.push(single(message));
    }
  }
  flush();
  return out;
}

/** `group-turn`: within each turn, all completed tool cards collapse into ONE
 *  cluster anchored at the first card's slot; narration and any running card
 *  stay singles in place. A turn with ≤1 completed card is left ungrouped. */
function groupTurn(messages: ChatMessage[]): MessageGroup[] {
  const out: MessageGroup[] = [];
  for (const segment of segmentByTurn(messages)) {
    const completed = segment.filter(isCompletedToolCard);
    if (completed.length < 2) {
      for (const m of segment) out.push(single(m));
      continue;
    }
    let clusterEmitted = false;
    for (const m of segment) {
      if (isCompletedToolCard(m)) {
        if (!clusterEmitted) {
          out.push({
            type: "tool-group",
            id: `toolgroup-${completed[0].id}`,
            messages: completed,
          });
          clusterEmitted = true;
        }
        // subsequent completed cards are already inside the cluster
      } else {
        out.push(single(m));
      }
    }
  }
  return out;
}

/** `group-block`: every *completed* turn that used at least one tool folds
 *  into a single collapsible block (the boundary user message stays a single).
 *  The last turn is always left expanded so an in-progress turn — streaming
 *  text or tools — is never hidden behind a collapsed block. */
function groupBlock(messages: ChatMessage[]): MessageGroup[] {
  const segments = segmentByTurn(messages);
  const lastIndex = segments.length - 1;
  const out: MessageGroup[] = [];
  segments.forEach((segment, i) => {
    const hasTool = segment.some(isToolCardMessage);
    // A still-running tool card means live progress — never fold it away, even
    // in an earlier segment (e.g. a turn that errored mid-tool and was left
    // without an `endedAt`). Matches this mode's "completed turns" contract.
    const hasRunning = segment.some(isRunningToolCard);
    if (i === lastIndex || !hasTool || hasRunning) {
      for (const m of segment) out.push(single(m));
      return;
    }
    const leadsWithUser = segment[0]?.role === "user";
    const blockMessages = leadsWithUser ? segment.slice(1) : segment;
    if (leadsWithUser) out.push(single(segment[0]));
    if (blockMessages.length === 0) return;
    out.push({
      type: "turn-block",
      id: `turnblock-${blockMessages[0].id}`,
      messages: blockMessages,
    });
  });
  return out;
}

/**
 * Transform the flat message list into render groups according to the
 * tool-call visibility mode:
 *   - `show`        → one single per message;
 *   - `hide`        → tool-card messages dropped entirely;
 *   - `group-run`   → consecutive completed tool cards fold into clusters;
 *   - `group-turn`  → all of a turn's completed tool cards fold into one
 *                     chronological cluster;
 *   - `group-block` → each completed tool-using turn folds into one block.
 *
 * Pure + order-preserving so it's safe to memoize and easy to test.
 */
export function groupMessages(
  messages: ChatMessage[],
  mode: ToolCallsMode,
): MessageGroup[] {
  switch (mode) {
    case "show":
      return messages.map(single);
    case "hide":
      return messages.filter((m) => !isToolCardMessage(m)).map(single);
    case "group-run":
      return groupRun(messages);
    case "group-turn":
      return groupTurn(messages);
    case "group-block":
      return groupBlock(messages);
  }
}

/** Stable React key for a group. */
export function groupKey(group: MessageGroup): string {
  return group.type === "single" ? group.message.id : group.id;
}

/** The stable anchor message id a group maps to — the first contained message
 *  for clusters. Used to preserve the user's reading position across a
 *  visibility (filter) change that rebuilds the group list, since the synthetic
 *  cluster ids differ between modes but message ids do not. */
export function anchorMessageIdForGroup(
  group: MessageGroup | undefined,
): string | undefined {
  if (!group) return undefined;
  return group.type === "single" ? group.message.id : group.messages[0]?.id;
}

/** Index of the group that CONTAINS the given message id, or -1 if none does.
 *  A message can be a `single` in one mode and folded into a cluster in another,
 *  so both shapes are searched. */
export function findGroupIndexForMessageId(
  groups: readonly MessageGroup[],
  id: string | undefined,
): number {
  if (!id) return -1;
  return groups.findIndex((g) =>
    g.type === "single"
      ? g.message.id === id
      : g.messages.some((m) => m.id === id),
  );
}
