export function activeWorkspaceCwd(
  state: Record<string, unknown>,
): string | null {
  const wtId =
    typeof state.activeWorkspaceId === "string" && state.activeWorkspaceId.length > 0
      ? state.activeWorkspaceId
      : null;
  if (wtId) {
    const projects =
      ((state.sidebar as
        | { projects?: Array<{ workspaces?: Array<{ id?: string; path?: string }> }> }
        | undefined)?.projects) ?? [];
    for (const project of projects) {
      const workspace = project.workspaces?.find((w) => w.id === wtId);
      if (workspace?.path) return workspace.path;
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
