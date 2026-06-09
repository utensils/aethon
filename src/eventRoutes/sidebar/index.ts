/**
 * Sidebar event-route handlers. The 22-handler surface previously lived
 * in `sidebar.ts`; submodules under this directory carry per-domain
 * implementations:
 *
 *  - resize.ts    — sidebar resize / resize-end (layout column token)
 *  - project.ts   — remove / toggle-expand / rename / open-finder /
 *                   copy-path / set-workspace-base (project CRUD + chrome)
 *  - session.ts   — delete-session / rename-session (with consent prompt)
 *  - workspace.ts  — create / switch / open-in-new-tab / start-session /
 *                   remove / cancel-pending / retry-pending / rename /
 *                   open-finder / copy-path (10 workspace handlers)
 *  - extension.ts — toggle-extension (bridge command)
 *  - chrome.ts    — handleSectionedSelect (sidebar + model-picker +
 *                   appearance-menu select dispatch by sectionId)
 *
 * The eventRoutes/index.ts barrel imports all 22 handlers from "./sidebar"
 * which resolves to this directory's index.ts — caller untouched.
 */

export {
  handleSidebarResize,
  handleSidebarResizeEnd,
} from "./resize";
export {
  handleSidebarRemoveProject,
  handleSidebarToggleProjectExpand,
  handleSidebarOpenProjectInFinder,
  handleSidebarCopyProjectPath,
  handleSidebarRenameProject,
  handleSidebarSetProjectWorkspaceBase,
} from "./project";
export {
  handleSidebarDeleteSession,
  handleSidebarRenameSession,
} from "./session";
export {
  handleSidebarCreateWorkspace,
  handleSidebarSwitchWorkspace,
  handleSidebarOpenWorkspaceInNewTab,
  handleSidebarStartSession,
  handleSidebarRemoveWorkspace,
  handleSidebarCancelPendingWorkspace,
  handleSidebarRetryPendingWorkspace,
  handleSidebarRenameWorkspace,
  handleSidebarReorderWorkspace,
  handleSidebarSortProjectWorkspaces,
  handleSidebarOpenWorkspaceInFinder,
  handleSidebarCopyWorkspacePath,
} from "./workspace";
export { handleSidebarToggleExtension } from "./extension";
export { handleSectionedSelect } from "./chrome";
