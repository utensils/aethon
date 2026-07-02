// Files screen — a touch drill-down over the active workspace root,
// backed by the gateway's fs_list_dir (root-checked desktop-side). Read-
// only: tapping a directory descends, tapping a file opens it read-only
// in the mobile file viewer overlay (Phase 5). Self-contained drill
// state (no app-state slice) keyed off the active workspace root.

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import { activeWorkspaceCwd } from "../../utils/activeWorkspaceRoot";

interface FsEntry {
  name: string;
  isDir: boolean;
}

function joinRel(rel: string, name: string): string {
  return rel ? `${rel}/${name}` : name;
}

function parentRel(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? "" : rel.slice(0, idx);
}

export function MobileFileList({ state, onEvent }: BuiltinComponentProps) {
  const root = activeWorkspaceCwd(state);
  const [rel, setRel] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (nextRel: string) => {
      if (!root) return;
      setLoading(true);
      try {
        const raw = await invoke<Array<{ name: string; isDir?: boolean; is_dir?: boolean }>>(
          "fs_list_dir",
          { root, path: nextRel },
        );
        const list = (Array.isArray(raw) ? raw : []).map((e) => ({
          name: e.name,
          isDir: Boolean(e.isDir ?? e.is_dir),
        }));
        // Directories first, then case-insensitive by name.
        list.sort((a, b) =>
          a.isDir === b.isDir
            ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
            : a.isDir
              ? -1
              : 1,
        );
        setEntries(list);
        setError(null);
      } catch (err) {
        setError(String(err));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [root],
  );

  // Reload from the top when the root changes (workspace switch) or on
  // first mount — a resync to the new dependency, not ongoing state.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRel("");
    void load("");
  }, [load]);

  if (!root) {
    return <p className="ae-mobile-files-empty">Open a project to browse files.</p>;
  }

  return (
    <div className="ae-mobile-files">
      <div className="ae-mobile-files-crumb">{rel || "/"}</div>
      {error ? <p className="ae-mobile-files-error">{error}</p> : null}
      <ul className="ae-mobile-file-rows">
        {rel ? (
          <li>
            <button
              type="button"
              className="ae-mobile-file-row ae-mobile-file-row--up"
              onClick={() => {
                const up = parentRel(rel);
                setRel(up);
                void load(up);
              }}
            >
              <span className="ae-mobile-file-glyph" aria-hidden>
                ↑
              </span>
              ..
            </button>
          </li>
        ) : null}
        {entries.map((entry) => (
          <li key={entry.name}>
            <button
              type="button"
              className="ae-mobile-file-row"
              onClick={() => {
                if (entry.isDir) {
                  const next = joinRel(rel, entry.name);
                  setRel(next);
                  void load(next);
                } else {
                  onEvent("open-file", { root, path: joinRel(rel, entry.name) });
                }
              }}
            >
              <span className="ae-mobile-file-glyph" aria-hidden>
                {entry.isDir ? "▸" : "·"}
              </span>
              {entry.name}
            </button>
          </li>
        ))}
        {!loading && entries.length === 0 && !error ? (
          <li className="ae-mobile-files-empty">Empty directory.</li>
        ) : null}
      </ul>
    </div>
  );
}
