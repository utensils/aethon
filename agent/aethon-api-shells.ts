/**
 * Builder for the `aethon.shells` sub-API (opt-in shell sharing).
 *
 * Extracted from `aethon-api.ts` so the `buildAethonApi` factory stays a
 * thin composition root. The shell surface rounds every op through the
 * mutation-ack channel via a bounded `shell_query` bridge message; the
 * `ShareMode` security floor is enforced Rust-side, not here.
 */

import type { AethonAgentState, MutationResult } from "./state";
import type { ShellsApi } from "./aethon-api";
import { trackMutation } from "./mutation-ack";

export interface ShellsApiDeps {
  send: (obj: Record<string, unknown>) => void;
}

const SHELL_WRITE_ACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — user may step away
const MUTATION_ACK_TIMEOUT_MS_DEFAULT = 5_000;

export function buildShellsApi(
  state: AethonAgentState,
  deps: ShellsApiDeps,
): ShellsApi {
  // -- shells.list/read/write --------------------------------------------
  async function shellQuery(
    op: "list" | "read" | "write",
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<MutationResult> {
    if (!state.frontendReady) {
      // Bounded handshake wait — see shellQuery comment in original main.ts.
      const ready = await Promise.race<boolean>([
        state.frontendReadyPromise.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), MUTATION_ACK_TIMEOUT_MS_DEFAULT),
        ),
      ]);
      if (!ready) return { ok: false, error: "frontend_not_ready" };
    }
    const { id, promise } = trackMutation(state, timeoutMs);
    deps.send({ type: "shell_query", mutationId: id, op, args });
    return promise;
  }

  return {
    list: () => shellQuery("list"),
    read: (input) => {
      if (!input || typeof input.tabId !== "string" || !input.tabId) {
        return Promise.resolve({ ok: false, error: "tabId required" });
      }
      return shellQuery("read", {
        tabId: input.tabId,
        ...(typeof input.sinceTotal === "number"
          ? { sinceTotal: input.sinceTotal }
          : {}),
        ...(typeof input.maxBytes === "number"
          ? { maxBytes: input.maxBytes }
          : {}),
      });
    },
    write: (input) => {
      if (!input || typeof input.tabId !== "string" || !input.tabId) {
        return Promise.resolve({ ok: false, error: "tabId required" });
      }
      if (typeof input.text !== "string") {
        return Promise.resolve({ ok: false, error: "text must be a string" });
      }
      return shellQuery(
        "write",
        { tabId: input.tabId, text: input.text },
        SHELL_WRITE_ACK_TIMEOUT_MS,
      );
    },
  };
}
