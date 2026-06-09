import type {
  AethonAgentState,
  ExtensionFailure,
  ExtensionFailureSource,
} from "./state";
import { emitReady } from "./tab-lifecycle";
import { refreshPersistedTabs } from "./extension-loader";

const WORKER_MODE =
  typeof process.env.AETHON_WORKER_TAB_ID === "string" &&
  process.env.AETHON_WORKER_TAB_ID.length > 0;

export interface DispatcherDeps {
  send: (obj: Record<string, unknown>) => void;
  scheduleStateFileWrite: () => void;
  /** Persistent extension hooks shared across all loaders so the failures
   *  registry stays in sync with the lifecycle events. */
  loadHooks: {
    onLoaded?: (name: string) => void;
    onProjectLoaded?: (name: string, projectRoot: string) => void;
    onFailure?: (
      f: ExtensionFailure & { name: string; source: ExtensionFailureSource },
    ) => void;
  };
}

export interface InboundMessage {
  type: string;
  content?: string;
  images?: {
    id?: string;
    name?: string;
    mimeType: string;
    data: string;
  }[];
  mode?: "normal" | "steer";
  cwd?: string;
  model?: string;
  /** Per-tab hard project-root guardrail override, carried on `chat`. */
  hardEnforce?: boolean;
  name?: string;
  args?: string;
  id?: string;
  tabId?: string;
  /** pi session entry id — carried on `rollback_session` / `fork_session`. */
  entryId?: string;
  componentType?: string;
  template?: unknown;
  path?: string;
  value?: unknown;
  payload?: unknown;
  config?: unknown;
  theme?: unknown;
  mutationId?: string;
  success?: boolean;
  error?: string;
  providerId?: string;
  profileId?: string;
  label?: string;
  key?: string;
  challengeId?: string;
  event?: {
    componentId?: string;
    componentType?: string;
    templateRootType?: string;
    eventType?: string;
    data?: unknown;
  };
  /** Devshell push event forwarded from the frontend's Tauri event
   *  listener. Sent on `devshell-ready` / `devshell-failed` /
   *  `devshell-resolving` so the agent's local cache stays in sync
   *  without requiring the spawnHook to poll. */
  devshellStatus?: "ready" | "failed" | "resolving";
  devshellRoot?: string;
  devshellKind?: string;
}

export async function emitGlobalReady(
  state: AethonAgentState,
  deps: { send: (obj: Record<string, unknown>) => void },
): Promise<void> {
  if (WORKER_MODE) return;
  state.discoveredTabs = await refreshPersistedTabs(state);
  emitReady(state, deps);
}

/** If a reload was requested AND no tab has a prompt in flight, write
 *  the `_reload_done` sentinel and exit cleanly. The Rust supervisor's
 *  stdout reader watches for the sentinel so it can flag the upcoming
 *  EOF as an intentional reload instead of a crash. */
export function maybeExitForReload(
  state: AethonAgentState,
  deps: DispatcherDeps,
): void {
  if (!state.reloadPending) return;
  for (const tab of state.tabs.values()) {
    if (tab.promptInFlight) return;
  }
  deps.send({ type: "_reload_done" });
  // Flush stdout before exiting so the supervisor sees the sentinel
  // before the EOF.
  if (typeof process.stdout.write === "function") {
    try {
      process.stdout.write("");
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
