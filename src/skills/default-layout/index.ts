/**
 * Default-layout skill — bundles the layout components and a default A2UI
 * payload that arranges them. Registered eagerly at app startup so the
 * out-of-the-box workspace UI renders through the same skill plumbing
 * third-party skills will use.
 */

import type { A2UIPayload } from "../../types/a2ui";
import type { A2UISkill } from "../types";
import {
  ChatHistory,
  ChatInput,
  EditorCanvas,
  EmptyState,
  WorktreeLanding,
  FileTreePanel,
  ImageViewer,
  Layout,
  MainCanvas,
  MarkdownPreview,
  ShellCanvas,
  Sidebar,
  StatusBar,
  TabStrip,
  Terminal,
  TerminalPanel,
  ToolCard,
} from "./components";
import {
  AgentStatusPill,
  AppearanceMenu,
  ModelPicker,
} from "./variation-components";
import { CommandPalette } from "./command-palette";
import { NotificationStack } from "./notifications";
import { SettingsPanel } from "./settings-panel";
import { SearchPanel } from "./search-panel";
import { ShareModeBadge } from "./share-mode-badge";
import workstationPayload from "./workstation.a2ui.json";

export {
  layoutSlots,
  SLOT_NAMES,
  REQUIRED_SLOT_NAMES,
  isKnownSlot,
  inspectLayoutSlotCoverage,
} from "./slots";
export type {
  LayoutSlotDefinition,
  LayoutSlotCatalogue,
  SlotCoverageReport,
} from "./slots";

export const defaultLayoutSkill: A2UISkill = {
  name: "default-layout",
  components: {
    layout: Layout,
    sidebar: Sidebar,
    "chat-history": ChatHistory,
    "chat-input": ChatInput,
    "status-bar": StatusBar,
    "tab-strip": TabStrip,
    terminal: Terminal,
    "main-canvas": MainCanvas,
    // M6 P1: full-canvas interactive PTY for shell tabs. Layouts may slot
    // it into the canvas area with `visible: { $ref: "/kind" }` (or an
    // equivalent mode flag) so it appears only when the active tab is a
    // shell tab.
    "shell-canvas": ShellCanvas,
    // Monaco-backed editor canvas for editor tabs. Mounts when the
    // active tab is `kind === "editor"`; the layout binds visibility
    // to `/editorTabActive`.
    "editor-canvas": EditorCanvas,
    // Project file tree — sidebar surface that lists the active
    // project's working directory. Single click on a file opens an
    // editor tab. Disabled with an empty state when no project is
    // active.
    "file-tree": FileTreePanel,
    // Built-in file viewers — dispatched by EditorCanvas when the
    // active editor tab's path matches an entry in the file-viewer
    // registry (image extensions ship out of the box). Extensions can
    // override either component via `aethon.registerComponent`.
    "image-viewer": ImageViewer,
    "markdown-preview": MarkdownPreview,
    // M6 restructure: tabbed bottom panel. Hosts the read-only
    // agent-bash sub-tab + every user shell as a separate sub-tab.
    // Replaces the standalone `terminal` cell in workstation.
    "terminal-panel": TerminalPanel,
    // M6 P4: tool-call card with live elapsed-time clock + long-running
    // amber warning at 30s. Bridge emits this for tool execution events
    // (replacing the plain `card` primitive in toolCardPayload).
    "tool-card": ToolCard,
    "empty-state": EmptyState,
    // Worktree landing page — shown when the user clicks a worktree in
    // the sidebar but hasn't yet started a session. Mirrors EmptyState
    // shape but scoped to a single worktree (cwd + branch + GitHub
    // status placeholder).
    "worktree-landing": WorktreeLanding,
    // Workstation header chrome — agent-status pill (canonical
    // `agent-pulse`; legacy `agent-status-pill` alias kept so existing
    // layout payloads continue to render after the rename) plus the
    // model + appearance pickers.
    "agent-pulse": AgentStatusPill,
    "agent-status-pill": AgentStatusPill,
    "model-picker": ModelPicker,
    "appearance-menu": AppearanceMenu,
    "command-palette": CommandPalette,
    "notification-stack": NotificationStack,
    "settings-panel": SettingsPanel,
    "search-panel": SearchPanel,
    // M6 P2: shell tab share-mode badge — extracted as its own
    // registerable component so a skill can replace it (e.g. with a
    // custom click-flow or icon set) without rewriting the whole shell
    // status bar.
    "share-mode-badge": ShareModeBadge,
  },
  layout: workstationPayload,
};

// Built-in layout catalogue. Each entry is a complete A2UI payload the
// user can swap to via `aethon.activateLayout(id)` or `/layout <id>`.
// Extensions can append more via `aethon.registerLayout({id, name, payload})`.
export interface LayoutCatalogueEntry {
  id: string;
  name: string;
  description?: string;
  payload: A2UIPayload;
}

// Sibling layouts (live-layout / editorial / command-deck) were trimmed
// while we focus polish on the workstation surface; their A2UI payloads
// + chrome components stay deletable (no callers reference them via the
// catalogue). Re-add entries here when reintroducing variations.
export const builtinLayouts: LayoutCatalogueEntry[] = [
  {
    id: "workstation",
    name: "Workstation",
    description:
      "Default — IDE-density sidebar, header pill, chrome tabs, terminal, composer, status bar.",
    payload: workstationPayload,
  },
];
