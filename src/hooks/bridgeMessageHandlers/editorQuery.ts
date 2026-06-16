import { invoke } from "@tauri-apps/api/core";
import type { BridgeMessageHandler } from "./types";

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : {};
}

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^[/\\]{2}[^/\\]/.test(path)
  );
}

function joinRoot(root: string, relativePath: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const rel = relativePath
    .replace(/^[\\/]+/, "")
    .split(/[\\/]+/)
    .filter((part) => part.length > 0 && part !== ".")
    .join(separator);
  return `${root.replace(/[\\/]+$/, "")}${separator}${rel}`;
}

function normalizeRootPath(root: string): string {
  const trimmed = root.trim();
  if (/^\/+$/.test(trimmed)) return "/";
  if (/^\\+$/.test(trimmed)) return "\\";
  if (/^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}

function matchingEditorTabId(
  tabs: unknown,
  filePath: string,
  rootPath: string,
): string | undefined {
  if (!Array.isArray(tabs)) return undefined;
  for (const tab of tabs) {
    if (!tab || typeof tab !== "object") continue;
    const rec = tab as {
      id?: unknown;
      kind?: unknown;
      editor?: { filePath?: unknown; rootPath?: unknown; diff?: unknown };
    };
    if (
      typeof rec.id === "string" &&
      rec.kind === "editor" &&
      rec.editor?.filePath === filePath &&
      (rec.editor.rootPath ?? "") === rootPath &&
      rec.editor.diff !== true
    ) {
      return rec.id;
    }
  }
  return undefined;
}

/** Bridge proxy for `aethon.editor.openFile`.
 *
 *  The agent sends the active tab cwd it resolved from its per-turn context.
 *  The frontend remains the authority for filesystem validation and tab
 *  mutation: `fs_exists` applies the same root boundary checks as Monaco's
 *  later `fs_read_file`, and `newEditorTab` is the shared human/agent open path.
 */
export const handleEditorQuery: BridgeMessageHandler = (data, ctx) => {
  const op = data.op as string | undefined;
  const args = asRecord(data.args);
  const mid = data.mutationId;

  const route = async (): Promise<unknown> => {
    if (op !== "open_file") {
      throw new Error(`unknown editor_query op: ${op}`);
    }
    const requestedPath =
      typeof args.path === "string" ? args.path.trim() : "";
    if (!requestedPath) throw new Error("editor_query.open_file requires path");

    const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const explicitRoot =
      typeof args.rootPath === "string" ? args.rootPath.trim() : "";
    const rootPath = normalizeRootPath(explicitRoot || cwd);
    if (!rootPath) {
      throw new Error("editor_query.open_file requires cwd or rootPath");
    }

    const filePath = isAbsolutePath(requestedPath)
      ? requestedPath
      : joinRoot(rootPath, requestedPath);
    const exists = await invoke("fs_exists", {
      root: rootPath,
      path: filePath,
    });
    if (exists !== true) {
      throw new Error(`file not found or outside root: ${requestedPath}`);
    }

    const existingTabId = matchingEditorTabId(
      ctx.stateRef.current.tabs,
      filePath,
      rootPath,
    );
    ctx.newEditorTab(filePath, { rootPath });
    return {
      filePath,
      rootPath,
      ...(existingTabId ? { tabId: existingTabId } : {}),
    };
  };

  route()
    .then((result) => ctx.ackMutation(mid, true, undefined, result))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ackMutation(mid, false, msg);
    });
};
