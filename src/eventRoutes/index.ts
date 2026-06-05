/** Event route table. Maps each renderer-side event to a handler.
 *  Adding a new route:
 *
 *    1. Create `eventRoutes/<name>.ts` exporting an `EventRouteHandler`.
 *    2. Register it under the appropriate prefix key(s) in
 *       BUILTIN_ROUTE_TABLE below.
 *    3. Add a happy-path test in `eventRoutes/<name>.test.ts`.
 *
 *  Three precedence layers, enforced by `dispatchEvent`:
 *
 *    1. **Shell-consent reserved prefixes** — security boundary. A
 *       user's Allow / Deny / dismiss on a shell-write / shell-close
 *       / session-delete prompt MUST resolve before any extension
 *       matcher sees the event.
 *    2. **Extension event routes** — when an extension has registered
 *       a route that matches this event, the dispatcher returns
 *       `false` (renderer forwards to bridge → extension's
 *       `aethon.onEvent` handler runs), skipping built-ins.
 *    3. **Built-in routes** — keyed by `id:<componentId>` and
 *       `type:<componentType>`; each handler returns `true` if it
 *       matched and handled.
 *
 *  See `dispatchEvent.test.ts` for the precedence contract test. */
import type {
  EventRouteContext,
  EventRouteEvent,
  EventRouteHandler,
} from "./types";
import { handleShellConsent } from "./shellConsent";
import { matchesExtensionRoute } from "./extensions";
import { handleChatInput } from "./chatInput";
import { handleChatMessages } from "./chatMessages";
import { handleSessionBranch } from "./session";
import { handleComposerPills } from "./composerPills";
import { handleQueuedMessages } from "./queue";
import { handleSettings } from "./settings";
import { handleAuthProfiles } from "./authProfiles";
import { handleSearch } from "./search";
import { handlePalette } from "./palette";
import { handleNotifications } from "./notifications";
import { handleTerminalPanel, handleShareModeCycle } from "./terminal";
import { handleTabStrip, handleEmptyState } from "./tabStrip";
import {
  handleSidebarResize,
  handleSidebarResizeEnd,
  handleSidebarRemoveProject,
  handleSidebarDeleteSession,
  handleSidebarRenameSession,
  handleSidebarToggleExtension,
  handleSectionedSelect,
  handleSidebarToggleProjectExpand,
  handleSidebarCreateWorktree,
  handleSidebarSwitchWorktree,
  handleSidebarStartSession,
  handleSidebarOpenWorktreeInNewTab,
  handleSidebarRemoveWorktree,
  handleSidebarCancelPendingWorktree,
  handleSidebarRetryPendingWorktree,
  handleSidebarRenameWorktree,
  handleSidebarReorderWorktree,
  handleSidebarSortProjectWorktrees,
  handleSidebarOpenProjectInFinder,
  handleSidebarCopyProjectPath,
  handleSidebarOpenWorktreeInFinder,
  handleSidebarCopyWorktreePath,
  handleSidebarRenameProject,
  handleSidebarSetProjectWorktreeBase,
} from "./sidebar";
import { handleEditorCanvas, handleFileTree } from "./editor";
import {
  handleProjectsDashboard,
  handleProjectDashboard,
  handleTaskLauncher,
  handleGhStatsStrip,
} from "./dashboard";

/** Lookup table for built-in routes. Keys are `id:<componentId>` or
 *  `type:<componentType>`. The dispatcher computes both keys for an
 *  event and concatenates the matched handler lists. Order within a
 *  list is the order of declaration here.
 *
 *  Chrome composites are keyed by **type** so a custom layout payload
 *  (or a `aethon.registerComponent(<type>, …)` override) that renames
 *  the instance still routes correctly. `id:<…>` is reserved for true
 *  instance-specific routing — none today. */
export const BUILTIN_ROUTE_TABLE: ReadonlyMap<string, readonly EventRouteHandler[]> =
  new Map<string, readonly EventRouteHandler[]>([
    // notification-stack: `handleShellConsent` is run separately as the
    // top-precedence gate; the general handler runs here.
    ["type:notification-stack", [handleNotifications]],
    ["type:settings-panel", [handleSettings]],
    ["type:auth-profile-panel", [handleAuthProfiles]],
    ["type:search-panel", [handleSearch]],
    ["type:command-palette", [handlePalette]],
    // Order matters: handleQueuedMessages runs FIRST and only matches
    // `queue:*` events, returning false for everything else. That lets
    // the inlined popover's events route correctly while normal chat
    // input events (submit / change / cancel) still flow to
    // handleChatInput unchanged.
    ["type:chat-input", [handleQueuedMessages, handleChatInput]],
    ["type:composer-visibility-pills", [handleComposerPills]],
    ["type:chat-history", [handleChatMessages, handleSessionBranch]],
    ["type:main-canvas", [handleChatMessages, handleSessionBranch]],
    ["type:queued-messages-popover", [handleQueuedMessages]],
    ["type:empty-state", [handleEmptyState]],
    // Worktree landing — session rows share dashboard restore/delete
    // semantics; Start Session + Open in Files reuse the sidebar's
    // worktree routes since their destinations are identical.
    ["type:worktree-landing", [
      handleProjectsDashboard,
      handleSidebarStartSession,
      handleSidebarOpenWorktreeInFinder,
    ]],
    ["type:sidebar", [
      handleSidebarResize,
      handleSidebarResizeEnd,
      handleSidebarToggleProjectExpand,
      handleSidebarRenameProject,
      handleSidebarSetProjectWorktreeBase,
      handleSidebarRemoveProject,
      handleSidebarOpenProjectInFinder,
      handleSidebarCopyProjectPath,
      handleSidebarCreateWorktree,
      handleSidebarSwitchWorktree,
      handleSidebarOpenWorktreeInNewTab,
      handleSidebarRemoveWorktree,
      handleSidebarCancelPendingWorktree,
      handleSidebarRetryPendingWorktree,
      handleSidebarRenameWorktree,
      handleSidebarReorderWorktree,
      handleSidebarSortProjectWorktrees,
      handleSidebarOpenWorktreeInFinder,
      handleSidebarCopyWorktreePath,
      handleSidebarDeleteSession,
      handleSidebarRenameSession,
      handleSidebarToggleExtension,
      handleSectionedSelect,
    ]],
    ["type:model-picker", [handleSectionedSelect]],
    ["type:appearance-menu", [handleSectionedSelect]],
    ["type:terminal-panel", [handleTerminalPanel]],
    ["type:tab-strip", [handleTabStrip]],
    ["type:shell-canvas", [handleShareModeCycle]],
    ["type:share-mode-badge", [handleShareModeCycle]],
    ["type:editor-canvas", [handleEditorCanvas]],
    ["type:file-tree", [handleFileTree]],
    // M9 dashboard surfaces. Keyed by type so a custom dashboard
    // (registered via aethon.registerComponent) routes through the
    // same handlers without an alias entry.
    ["type:projects-dashboard", [handleProjectsDashboard]],
    ["type:project-dashboard", [handleProjectDashboard]],
    ["type:task-launcher", [handleTaskLauncher]],
    ["type:gh-stats-strip", [handleGhStatsStrip]],
    // VCS surface. The header cluster only opens external URLs; the
    // source-control panel also opens changed files in an editor tab
    // (handleFileTree claims `file-tree-open`, falling through to the
    // opener for PR/CI `open-url`).
    ["type:vcs-status", [handleFileTree, handleGhStatsStrip]],
    ["type:source-control-panel", [handleFileTree, handleGhStatsStrip]],
    ["type:project-card", [handleProjectsDashboard]],
    // Issues section emits the same `start-task` payload as the task
    // launcher (when the user picks "Send to agent" on an issue row)
    // and `open-url` for the in-menu "Open on GitHub" affordance.
    // Reuse the existing handlers so the dispatch chain stays one
    // implementation.
    ["type:issues-section", [handleTaskLauncher, handleGhStatsStrip]],
  ]);

/** Dispatch a renderer-side event through the precedence layers.
 *  Returns true when a handler claimed the event (renderer suppresses
 *  its default forward); false when no handler claimed it OR an
 *  extension route matched (renderer forwards to bridge). */
export async function dispatchEvent(
  event: EventRouteEvent,
  ctx: EventRouteContext,
): Promise<boolean> {
  // Layer 1: shell-consent reserved prefixes.
  if (await handleShellConsent(event, ctx)) return true;

  // Layer 2: extension-route interception. When matched the renderer
  // forwards to the bridge so the extension's matcher fires; built-ins
  // are skipped entirely.
  if (matchesExtensionRoute(event, ctx)) return false;

  // Layer 3: built-ins. Look up handlers by id-key then type-key; first
  // handler to return true wins.
  const idKey = `id:${event.component.id}`;
  const handlers: EventRouteHandler[] = [];
  const idHandlers = BUILTIN_ROUTE_TABLE.get(idKey);
  if (idHandlers) handlers.push(...idHandlers);
  if (event.component.type) {
    const typeHandlers = BUILTIN_ROUTE_TABLE.get(
      `type:${event.component.type}`,
    );
    if (typeHandlers) handlers.push(...typeHandlers);
  }
  for (const handler of handlers) {
    if (await handler(event, ctx)) return true;
  }
  return false;
}

export type {
  EventRouteContext,
  EventRouteEvent,
  EventRouteHandler,
} from "./types";
