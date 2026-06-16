/**
 * Builder for the `aethon.editor` sub-API.
 *
 * The agent process cannot directly mutate React tab state, so editor actions
 * round-trip through the frontend via the mutation-ack channel. The frontend
 * resolves/validates paths against the active tab cwd and then reuses the same
 * `newEditorTab` path as the file tree.
 */

import type { AethonAgentState, MutationResult } from "./state";
import type { EditorApi } from "./aethon-api";
import { trackMutation } from "./mutation-ack";

export interface EditorApiDeps {
  send: (obj: Record<string, unknown>) => void;
}

const MUTATION_ACK_TIMEOUT_MS_DEFAULT = 5_000;

function currentCwd(state: AethonAgentState): string {
  const tabId = state.tabContext.getStore() ?? state.currentAgentTabId;
  return (
    (tabId ? state.tabProjectCwds.get(tabId) : undefined) ??
    state.currentProjectCwd ??
    state.userDir ??
    process.cwd()
  );
}

async function editorQuery(
  state: AethonAgentState,
  deps: EditorApiDeps,
  op: "open_file",
  args: Record<string, unknown> = {},
): Promise<MutationResult> {
  if (!state.frontendReady) {
    const ready = await Promise.race<boolean>([
      state.frontendReadyPromise.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), MUTATION_ACK_TIMEOUT_MS_DEFAULT),
      ),
    ]);
    if (!ready) return { ok: false, error: "frontend_not_ready" };
  }
  const { id, promise } = trackMutation(state);
  deps.send({ type: "editor_query", mutationId: id, op, args });
  return promise;
}

export function buildEditorApi(
  state: AethonAgentState,
  deps: EditorApiDeps,
): EditorApi {
  return {
    openFile: (input) => {
      if (!input || typeof input.path !== "string" || !input.path.trim()) {
        return Promise.resolve({ ok: false, error: "path required" });
      }
      return editorQuery(state, deps, "open_file", {
        path: input.path,
        cwd: currentCwd(state),
        ...(typeof input.rootPath === "string" && input.rootPath.trim()
          ? { rootPath: input.rootPath }
          : {}),
      });
    },
  };
}
