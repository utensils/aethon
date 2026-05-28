import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type {
  PaletteItem,
  PaletteMode,
} from "../../extensions/default-layout/palette-items";
import type { AethonConfig } from "../../config";
import type { SlashCommand } from "../../slashCommands";
import type { NotificationInput } from "../useNotifications";

export interface UseUiOverlaysContext {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  /** Apply a freshly-read AethonConfig into the live refs + theme/font
   *  CSS. Settings save calls this after `clearConfigCache()` +
   *  `getConfig()`. */
  reapplyConfig: (fresh: AethonConfig) => void;
  /** Surface settings save success/failure. */
  pushNotification: (n: NotificationInput) => string;

  // Palette dispatch dependencies.
  setActiveTab: (tabId: string) => void;
  newTab: (
    restoreId?: string,
    restoreLabel?: string,
    options?: {
      restoredSession?: boolean;
      cwd?: string;
      scrollToMatch?: string;
    },
  ) => void;
  /** Open (or focus) an editor tab for the file path — used by the
   *  palette's "files" mode (Cmd+P selection). */
  newEditorTab: (filePath: string) => void;
  setActiveProjectById: (id: string) => boolean;
  openProjectFromPicker: () => Promise<string | null>;
  closeTab: (tabId: string) => void;
  nextTab: (direction: 1 | -1) => void;
  toggleTerminalAndFocus: () => void;
  toggleFocusComposerTerminal: () => void;
  clearChat: () => void;
  stopPrompt: () => Promise<void>;
  adjustZoom: (delta: number) => void;
  resetZoom: () => void;
  setTheme: (id: string) => void;
  setModel: (id: string) => Promise<void>;
  activateLayoutById: (id: string) => boolean;
  sendChat: (text: string) => Promise<void>;
  slashCommandsRef: MutableRefObject<SlashCommand[]>;
  /** Build the live SlashCommandContext used by /palette slash items.
   *  Built per-invocation so handlers see fresh state without re-creating
   *  the command registry. */
  slashContext: () => Parameters<SlashCommand["run"]>[1];
}

export interface UseUiOverlaysActions {
  // Settings.
  openSettings: (section?: string) => void;
  toggleSettings: () => void;
  closeSettings: () => void;
  applySettingsPatch: (
    patch: Partial<{
      ui: unknown;
      agent: unknown;
      shell: unknown;
      shortcuts: unknown;
    }>,
  ) => void;
  saveSettings: () => Promise<void>;

  // Session search.
  toggleSessionSearch: () => void;
  closeSessionSearch: () => void;
  setSearchQuery: (value: string) => void;
  setSearchScope: (scope: "all" | "current") => void;
  openSearchHit: (hit: { tabId?: string; snippetMatch?: string }) => void;

  // Command palette.
  openPalette: (mode: PaletteMode) => void;
  closePalette: () => void;
  runPaletteItem: (item: PaletteItem) => Promise<void>;
}
