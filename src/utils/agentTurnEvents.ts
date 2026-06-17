/** A window-level signal fired once per completed agent turn. Decouples the
 *  bridge `response_end` handler (which knows the final reply) from features
 *  that react to a turn finishing — speak-agent-replies today, the
 *  conversation voice mode next — without threading them through the handler
 *  context. */
export const AGENT_TURN_COMPLETE_EVENT = "aethon://agent-turn-complete";

export interface AgentTurnCompleteDetail {
  tabId: string;
  /** The final assistant text for the turn ("" for tool-only/empty turns). */
  text: string;
}

export function emitAgentTurnComplete(detail: AgentTurnCompleteDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AgentTurnCompleteDetail>(AGENT_TURN_COMPLETE_EVENT, {
      detail,
    }),
  );
}

export function onAgentTurnComplete(
  listener: (detail: AgentTurnCompleteDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    listener((event as CustomEvent<AgentTurnCompleteDetail>).detail);
  };
  window.addEventListener(AGENT_TURN_COMPLETE_EVENT, handler);
  return () => window.removeEventListener(AGENT_TURN_COMPLETE_EVENT, handler);
}
