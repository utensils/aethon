import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  findActiveAtToken,
  isLeadingAtToken,
  matchAtMentions,
  type AtFileMatch,
  type AtMention,
  type AtSubagentMatch,
  subagentSuggestionsFromFiles,
} from "./at-mention";
import type { SubagentFile } from "../../subagents";

/**
 * Live `@` completion state for a composer. Modeled on
 * `useSlashMatching`: the caller feeds the draft + cursor + the root the
 * prompt will resolve against (`atMentionRoot(state)` for the chat
 * composer, the targeted project/workspace path for the task launcher),
 * and gets back the current match (or null) plus highlight/dismiss
 * controls.
 *
 * File matches come from `fs_walk_project` and agent matches come from
 * `subagents_list`. A walk fires each time an `@token` becomes active, while
 * the previous lists keep serving matches so suggestions never flicker out
 * mid-typing.
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
  const [subagents, setSubagents] = useState<AtSubagentMatch[]>([]);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);

  useEffect(() => {
    if (dismissedDraft !== null && value !== dismissedDraft) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot picker re-enable when the draft changes after Escape
      setDismissedDraft(null);
    }
  }, [value, dismissedDraft]);

  const tokenActive = token !== null;
  useEffect(() => {
    if (!tokenActive) return;
    let cancelled = false;
    if (root) {
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
          // Walk failed (project gone, permission) — degrade to no file rows.
          if (!cancelled) setFiles([]);
        });
    }
    invoke<SubagentFile[]>("subagents_list", { projectRoot: root ?? null })
      .then((raw) => {
        if (!cancelled) setSubagents(subagentSuggestionsFromFiles(raw));
      })
      .catch(() => {
        if (!cancelled) setSubagents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tokenActive, root]);

  const atMatch: AtMention | null = useMemo(() => {
    if (!token) return null;
    if (dismissedDraft !== null && value === dismissedDraft) return null;
    const matches = matchAtMentions({
      query: token.query,
      files: root ? files : [],
      subagents,
      includeAgents: isLeadingAtToken(value, token),
    });
    return matches.length > 0 ? { ...token, matches } : null;
  }, [token, root, files, subagents, value, dismissedDraft]);

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
