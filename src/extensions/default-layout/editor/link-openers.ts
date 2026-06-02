export interface EditorLinkResource {
  scheme: string;
  path: string;
  fsPath?: string;
  toString(): string;
}

export interface EditorLinkOpenDeps {
  currentTabId: string;
  projectPath: string;
  openExternalUrl: (url: string) => Promise<void>;
  openMarkdownFile: (data: {
    tabId: string;
    filePath: string;
    rootPath: string;
  }) => void;
}

export async function handleEditorLinkOpen(
  resource: EditorLinkResource,
  deps: EditorLinkOpenDeps,
): Promise<boolean> {
  const scheme = resource.scheme.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    try {
      await deps.openExternalUrl(resource.toString());
    } catch {
      /* opener failures are not actionable from Monaco's link UI */
    }
    return true;
  }

  if (scheme === "file") {
    const filePath = resource.fsPath || resource.path;
    if (!deps.currentTabId || !filePath) return false;
    deps.openMarkdownFile({
      tabId: deps.currentTabId,
      filePath,
      rootPath: deps.projectPath,
    });
    return true;
  }

  return false;
}
