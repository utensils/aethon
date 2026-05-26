import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { A2UIPayload, ChatMessage } from "../../types/a2ui";
import type { Tab } from "../../types/tab";
import type { NotificationInput } from "../useNotifications";

/** Everything the OS-edge subscribers may close over. The shape is
 *  intentionally flat so adding a new subscriber doesn't require a
 *  context-shape decision; per-subscriber narrowing happens inside
 *  each module's `Deps` interface. */
export interface UseOsEdgesContext {
  bootLayout: A2UIPayload;
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;

  // Refs from useChat / useBridgeMessages.
  activeResponseIdRef: MutableRefObject<string | null>;
  hangWarnTimersRef: MutableRefObject<
    Map<string, ReturnType<typeof setTimeout>>
  >;
  hangWarnActiveRef: MutableRefObject<Set<string>>;
  hangWarnNotifId: (tabId: string) => string;

  // Live config refs (from useBootConfig).
  autoRestartAgentRef: MutableRefObject<boolean>;

  // Tab actions (from useTabs).
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
  newTab: () => void;
  newShellTab: () => void;
  closeTab: (tabId: string) => void;
  nextTab: (direction: 1 | -1) => void;

  // Chat helpers (from useChat).
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  appendSystem: (text: string) => void;
  setStatusFlags: (
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) => void;
  clearChat: () => void;
  stopPrompt: () => Promise<void>;

  // Focus + chrome.
  toggleTerminal: () => void;
  toggleFilesSidebar: () => void;
  openSettings: (section?: string) => void;

  // Notifications.
  pushNotification: (n: NotificationInput) => string;
  dismissNotification: (id: string) => void;

  // Updater.
  checkForUpdates: () => Promise<void>;
}
