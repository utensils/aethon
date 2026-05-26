import type {
  AethonAgentState,
  ExtensionFailure,
  ExtensionFailureSource,
} from "./state";
import { emitReady } from "./tab-lifecycle";

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
  mode?: "normal" | "steer";
  cwd?: string;
  model?: string;
  name?: string;
  args?: string;
  id?: string;
  tabId?: string;
  componentType?: string;
  template?: unknown;
  path?: string;
  value?: unknown;
  payload?: unknown;
  theme?: unknown;
  mutationId?: string;
  success?: boolean;
  error?: string;
  event?: {
    componentId?: string;
    componentType?: string;
    templateRootType?: string;
    eventType?: string;
    data?: unknown;
  };
}

export function emitGlobalReady(
  state: AethonAgentState,
  deps: { send: (obj: Record<string, unknown>) => void },
): void {
  if (!WORKER_MODE) emitReady(state, deps);
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
