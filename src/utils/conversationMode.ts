/** Process-wide flag for whether the LFM2-Audio conversation voice mode is
 *  driving the speak loop. While active, the conversation hook owns synthesis
 *  + playback of agent replies, so `useSpeakReplies` stands down to avoid
 *  double-speaking the same turn. */
let active = false;

export function setConversationActive(value: boolean): void {
  active = value;
}

export function isConversationActive(): boolean {
  return active;
}
