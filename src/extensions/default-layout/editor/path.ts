/** Show the last 2 path components — full path is kept in the title attribute. */
export function compressPath(filePath: string): string {
  if (!filePath) return "";
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return filePath;
  return `…/${parts.slice(-2).join("/")}`;
}

/** Strip the project/worktree root from an absolute path for a
 *  VS Code-style "Copy Relative Path". Falls back to the absolute path
 *  when the root isn't a prefix. Shared by the editor menubar and the
 *  tab-strip context menu so the two surfaces agree. */
export function relativePath(filePath: string, root: string): string {
  if (!root) return filePath;
  const normRoot = root.replace(/[/\\]+$/, "");
  if (filePath === normRoot) return filePath;
  if (filePath.startsWith(`${normRoot}/`)) {
    return filePath.slice(normRoot.length + 1);
  }
  return filePath;
}

/** Best-effort clipboard write — Tauri's webview exposes the async
 *  Clipboard API; failures (denied permission, older webview) degrade
 *  silently rather than throwing into a click handler. */
export function copyToClipboard(text: string): void {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable */
  }
}
