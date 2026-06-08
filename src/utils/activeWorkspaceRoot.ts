export function activeWorkspaceCwd(
  state: Record<string, unknown>,
): string | null {
  const wtId =
    typeof state.activeWorktreeId === "string" && state.activeWorktreeId.length > 0
      ? state.activeWorktreeId
      : null;
  if (wtId) {
    const projects =
      ((state.sidebar as
        | { projects?: Array<{ worktrees?: Array<{ id?: string; path?: string }> }> }
        | undefined)?.projects) ?? [];
    for (const project of projects) {
      const worktree = project.worktrees?.find((w) => w.id === wtId);
      if (worktree?.path) return worktree.path;
    }
  }

  const projectPath =
    (state.project as { path?: string } | null | undefined)?.path ?? null;
  if (projectPath) return projectPath;

  const tabs =
    (state.tabs as
      | Array<{ id: string; kind?: string; editor?: { rootPath?: string } }>
      | undefined) ?? [];
  const activeTabId =
    typeof state.activeTabId === "string" ? state.activeTabId : undefined;
  const activeTab = activeTabId
    ? tabs.find((t) => t.id === activeTabId)
    : undefined;
  if (activeTab?.kind === "editor" && activeTab.editor?.rootPath) {
    return activeTab.editor.rootPath;
  }
  return null;
}
