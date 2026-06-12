import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  findActiveAtToken,
  matchAtFiles,
  type AtFileMatch,
  type AtMention,
} from "./at-mention";

/**
 * Live `@file` completion state for a composer. Modeled on
 * `useSlashMatching`: the caller feeds the draft + cursor + the root the
 * prompt will resolve against (`atMentionRoot(state)` for the chat
 * composer, the targeted project/workspace path for the task launcher),
 * and gets back the current match (or null) plus highlight/dismiss
 * controls.
 *
 * The file list comes from `fs_walk_project` — the same backend as the
 * Cmd+P quick-open. A walk fires each time an `@token` becomes active
 * (cheap: capped + excluded-dirs pruned Rust walk), while the previous
 * list keeps serving matches so suggestions never flicker out mid-typing.
 */
export function useAtMention({
  value,
  cursor,
  root,
  enabled,
}: {
  value: string;
  cursor: number;
  root: string | null;
  enabled: boolean;
}) {
  const token = useMemo(
    () => (enabled ? findActiveAtToken(value, cursor) : null),
    [enabled, value, cursor],
  );
  const [files, setFiles] = useState<AtFileMatch[]>([]);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);

  useEffect(() => {
    if (dismissedDraft !== null && value !== dismissedDraft) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot picker re-enable when the draft changes after Escape
      setDismissedDraft(null);
    }
  }, [value, dismissedDraft]);

  const tokenActive = token !== null;
  useEffect(() => {
    if (!tokenActive || !root) return;
    let cancelled = false;
    invoke<string[]>("fs_walk_project", { root })
      .then((paths) => {
        if (cancelled) return;
        const normalized = root.replace(/\/+$/, "");
        setFiles(
          paths.map((path) => ({
            path,
            rel: path.startsWith(normalized + "/")
              ? path.slice(normalized.length + 1)
              : path,
          })),
        );
      })
      .catch(() => {
        // Walk failed (project gone, permission) — degrade to no picker.
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tokenActive, root]);

  const atMatch: AtMention | null = useMemo(() => {
    if (!token) return null;
    if (dismissedDraft !== null && value === dismissedDraft) return null;
    const matches = matchAtFiles(token.query, files);
    return matches.length > 0 ? { ...token, matches } : null;
  }, [token, files, value, dismissedDraft]);

  const [highlightIdx, setHighlightIdx] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keep keyboard highlight inside the newly visible suggestion list
    setHighlightIdx(0);
  }, [atMatch?.matches.length, atMatch?.query, atMatch?.start]);

  return {
    atMatch,
    highlightIdx,
    setHighlightIdx,
    dismissPicker: () => setDismissedDraft(value),
  };
}
