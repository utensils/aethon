/**
 * Default-layout extension — bundles the layout components and a default A2UI
 * payload that arranges them. Registered eagerly at app startup so the
 * out-of-the-box workspace UI renders through the same extension plumbing
 * third-party extensions will use.
 */

import type { A2UIPayload } from "../../types/a2ui";
import type { A2UIExtension } from "../types";
// Eager surfaces import their SOURCE modules directly, not the
// ./components barrel — the barrel re-exports the editor/terminal/shell
// families, whose side-effect imports (monaco bootstrap, xterm CSS)
// would drag those chunks back into the boot bundle.
import {
  EmptyState,
  MobileDeviceLanding,
  WorkspaceLanding,
  Layout,
  StatusBar,
} from "./layout";
import { Sidebar } from "./sidebar";
import { FileTreePanel } from "./sidebar/file-tree";
import {
  ChatHistory,
  ChatInput,
  MainCanvas,
  QueuedMessagesPopover,
  SubagentResult,
  ToolCard,
} from "./chat";
import { QuestionCard } from "./question-card";
import { TabStrip } from "./shell/tab-strip";
import {
  AccountSelector,
  AgentStatusPill,
  AppearanceMenu,
  ModelPicker,
  VcsStatus,
} from "./variation-components";
import { ComposerVisibilityPills } from "./composer-visibility-pills";
import { NotificationStack } from "./notifications";
import { ShareModeBadge } from "./share-mode-badge";
import { GhStatsStrip } from "./dashboard/gh-stats-strip";
import { ProjectCard } from "./dashboard/project-card";
import { TaskLauncher } from "./dashboard/task-launcher";
import { ProjectsDashboard } from "./dashboard/projects-dashboard";
import { ProjectDashboard } from "./dashboard/project-dashboard";
import { IssuesSection } from "./dashboard/issues-section";
import { lazySurface } from "./lazySurface";
import workstationPayload from "./workstation.a2ui.json";

// Heavy surfaces that are closed (or invisible) at first paint load as
// their own chunks on first mount; `preloadDefaultLayoutSurfaces` warms
// them post-chrome-ready. Each loads its DIRECT source module so a
// light surface (markdown preview) never rides in a heavy chunk
// (monaco).
const EditorCanvas = lazySurface("editor-canvas", () =>
  import("./editor/canvas").then((m) => ({ default: m.EditorCanvas })),
);
const DiffCanvas = lazySurface("diff-canvas", () =>
  import("./editor/diff-canvas").then((m) => ({ default: m.DiffCanvas })),
);
const ImageViewer = lazySurface("image-viewer", () =>
  import("./editor/image-viewer").then((m) => ({ default: m.ImageViewer })),
);
const MarkdownPreview = lazySurface("markdown-preview", () =>
  import("./editor/markdown-preview").then((m) => ({
    default: m.MarkdownPreview,
  })),
);
const ShellCanvas = lazySurface("shell-canvas", () =>
  import("./shell/canvas").then((m) => ({ default: m.ShellCanvas })),
);
const TerminalPanel = lazySurface("terminal-panel", () =>
  import("./shell/panel").then((m) => ({ default: m.TerminalPanel })),
);
const Terminal = lazySurface("terminal", () =>
  import("./terminal").then((m) => ({ default: m.Terminal })),
);
const SettingsPanel = lazySurface("settings-panel", () =>
  import("./settings-panel").then((m) => ({ default: m.SettingsPanel })),
);
const AuthProfilePanel = lazySurface("auth-profile-panel", () =>
  import("./auth-profile-panel").then((m) => ({
    default: m.AuthProfilePanel,
  })),
);
const SearchPanel = lazySurface("search-panel", () =>
  import("./search-panel").then((m) => ({ default: m.SearchPanel })),
);
const ScheduledTasksPanel = lazySurface("scheduled-tasks-panel", () =>
  import("./scheduled-tasks-panel").then((m) => ({
    default: m.ScheduledTasksPanel,
  })),
);
const CommandPalette = lazySurface("command-palette", () =>
  import("./command-palette").then((m) => ({ default: m.CommandPalette })),
);
const SourceControlPanel = lazySurface("source-control-panel", () =>
  import("./sidebar/source-control-panel").then((m) => ({
    default: m.SourceControlPanel,
  })),
);
const SubagentsConfig = lazySurface("subagents-config", () =>
  import("./dashboard/subagents-config").then((m) => ({
    default: m.SubagentsConfig,
  })),
);

/** Warm every lazy surface chunk. Called from App on the first idle
 *  after chrome-ready so first-open latency is ~zero. */
export function preloadDefaultLayoutSurfaces(): void {
  for (const surface of [
    EditorCanvas,
    DiffCanvas,
    ImageViewer,
    MarkdownPreview,
    ShellCanvas,
    TerminalPanel,
    Terminal,
    SettingsPanel,
    AuthProfilePanel,
    SearchPanel,
    ScheduledTasksPanel,
    CommandPalette,
    SourceControlPanel,
    SubagentsConfig,
  ]) {
    void surface.preload();
  }
}

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

export const defaultLayoutExtension: A2UIExtension = {
  name: "default-layout",
  components: {
    layout: Layout,
    sidebar: Sidebar,
    "chat-history": ChatHistory,
    "chat-input": ChatInput,
    // Composer-bar tri-state visibility pills (Thinking / Tool calls) with a
    // "…" popover to promote the per-session choice to the global default.
    "composer-visibility-pills": ComposerVisibilityPills,
    // Popover above the composer listing client-held queued messages
    // with per-row edit / steer / delete. Drained by `useQueuedDispatch`
    // on the next idle. Replaceable via
    // `aethon.registerComponent("queued-messages-popover", custom)`.
    "queued-messages-popover": QueuedMessagesPopover,
    "question-card": QuestionCard,
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
    // Read-only side-by-side diff (HEAD vs working tree). EditorCanvas
    // dispatches it when the active editor tab carries `editor.diff`.
    "diff-canvas": DiffCanvas,
    // M6 restructure: tabbed bottom panel. Hosts the read-only
    // agent-bash sub-tab + every user shell as a separate sub-tab.
    // Replaces the standalone `terminal` cell in workstation.
    "terminal-panel": TerminalPanel,
    // M6 P4: tool-call card with live elapsed-time clock + long-running
    // amber warning at 30s. Bridge emits this for tool execution events
    // (replacing the plain `card` primitive in toolCardPayload).
    "tool-card": ToolCard,
    "subagent-result": SubagentResult,
    "empty-state": EmptyState,
    "mobile-device-landing": MobileDeviceLanding,
    // Workspace landing page — shown when the user clicks a workspace in
    // the sidebar but hasn't yet started a session. Mirrors EmptyState
    // shape but scoped to a single workspace (cwd + branch + GitHub
    // status placeholder).
    "workspace-landing": WorkspaceLanding,
    // Workstation header chrome — agent-status pill (canonical
    // `agent-pulse`; legacy `agent-status-pill` alias kept so existing
    // layout payloads continue to render after the rename) plus the
    // model + appearance pickers.
    "agent-pulse": AgentStatusPill,
    "agent-status-pill": AgentStatusPill,
    "model-picker": ModelPicker,
    "appearance-menu": AppearanceMenu,
    "account-selector": AccountSelector,
    "vcs-status": VcsStatus,
    "source-control-panel": SourceControlPanel,
    "command-palette": CommandPalette,
    "notification-stack": NotificationStack,
    "settings-panel": SettingsPanel,
    "auth-profile-panel": AuthProfilePanel,
    "search-panel": SearchPanel,
    "scheduled-tasks-panel": ScheduledTasksPanel,
    // M6 P2: shell tab share-mode badge — extracted as its own
    // registerable component so an extension can replace it (e.g. with a
    // custom click-flow or icon set) without rewriting the whole shell
    // status bar.
    "share-mode-badge": ShareModeBadge,
    // M9 dashboard composites. Each is registered with a stable type so
    // an extension can swap it via `aethon.registerComponent(<type>, …)`.
    // gh-stats-strip + project-card are leaf composites; the dashboard
    // surfaces (projects-dashboard, project-dashboard, task-launcher)
    // mount alongside.
    "gh-stats-strip": GhStatsStrip,
    "project-card": ProjectCard,
    "task-launcher": TaskLauncher,
    "projects-dashboard": ProjectsDashboard,
    "project-dashboard": ProjectDashboard,
    "issues-section": IssuesSection,
    "subagents-config": SubagentsConfig,
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
