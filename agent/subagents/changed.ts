/**
 * Handle the `subagents_changed` signal.
 *
 * The Rust side writes `{"type":"subagents_changed"}` to the bridge's stdin
 * after the UI creates / edits / deletes a subagent definition. We re-merge the
 * registry and reload the resource loader so the next turn's system prompt
 * re-advertises — without killing in-flight prompts (this is intentionally a
 * lighter signal than `reload_request`, which respawns the whole bridge).
 */

import type { AethonAgentState } from "../state";
import type { DispatcherDeps } from "../dispatcherTypes";
import { emitGlobalReady } from "../dispatcherTypes";
import { refreshSubagents } from "./loader";

export async function handleSubagentsChanged(
  state: AethonAgentState,
  deps: DispatcherDeps,
): Promise<void> {
  refreshSubagents(state);
  await state.resourceLoader.reload();
  deps.scheduleStateFileWrite();
  await emitGlobalReady(state, deps);
}
