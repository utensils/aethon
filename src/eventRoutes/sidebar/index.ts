/**
 * Sidebar event-route handlers. The 22-handler surface previously lived
 * in `sidebar.ts`; submodules under this directory carry per-domain
 * implementations:
 *
 *  - resize.ts    — sidebar resize / resize-end (layout column token)
 *  - project.ts   — remove / toggle-expand / rename / open-finder /
 *                   copy-path / set-worktree-base (project CRUD + chrome)
 *  - session.ts   — delete-session / rename-session (with consent prompt)
 *  - worktree.ts  — create / switch / open-in-new-tab / start-session /
 *                   remove / cancel-pending / retry-pending / rename /
 *                   open-finder / copy-path (10 worktree handlers)
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
  handleSidebarSetProjectWorktreeBase,
} from "./project";
export {
  handleSidebarDeleteSession,
  handleSidebarRenameSession,
} from "./session";
export {
  handleSidebarCreateWorktree,
  handleSidebarSwitchWorktree,
  handleSidebarOpenWorktreeInNewTab,
  handleSidebarStartSession,
  handleSidebarRemoveWorktree,
  handleSidebarCancelPendingWorktree,
  handleSidebarRetryPendingWorktree,
  handleSidebarRenameWorktree,
  handleSidebarReorderWorktree,
  handleSidebarSortProjectWorktrees,
  handleSidebarOpenWorktreeInFinder,
  handleSidebarCopyWorktreePath,
} from "./worktree";
export { handleSidebarToggleExtension } from "./extension";
export { handleSectionedSelect } from "./chrome";
