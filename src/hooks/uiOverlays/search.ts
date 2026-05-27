import type { Tab } from "../../types/tab";
import type { UseUiOverlaysContext } from "./types";

type SearchOverlayContext = Pick<
  UseUiOverlaysContext,
  "setState" | "stateRef" | "setActiveTab" | "newTab"
>;

export function useSearchOverlay(ctx: SearchOverlayContext) {
  const { setState, stateRef, setActiveTab, newTab } = ctx;

  /** Toggle the cross-session search overlay. State lives at `/search`;
   *  the SearchPanel composite reads `open` + `query` and invokes the
   *  debounced `search_sessions` Tauri command from the renderer side. */
  function toggleSessionSearch() {
    setState((prev) => {
      const cur =
        (prev.search as
          | { open?: boolean; scope?: "all" | "current" }
          | undefined) ?? {};
      return {
        ...prev,
        search: {
          open: !cur.open,
          query: "",
          scope: cur.scope ?? "all",
        },
      };
    });
  }

  function closeSessionSearch() {
    setState((prev) => {
      const cur =
        (prev.search as { scope?: "all" | "current" } | undefined) ?? {};
      return {
        ...prev,
        search: { open: false, query: "", scope: cur.scope ?? "all" },
      };
    });
  }

  function setSearchQuery(value: string) {
    setState((prev) => {
      const cur =
        (prev.search as
          | { open?: boolean; scope?: "all" | "current" }
          | undefined) ?? {};
      return {
        ...prev,
        search: {
          open: !!cur.open,
          query: value,
          scope: cur.scope ?? "all",
        },
      };
    });
  }

  function setSearchScope(scope: "all" | "current") {
    setState((prev) => {
      const cur =
        (prev.search as { open?: boolean; query?: string } | undefined) ?? {};
      return {
        ...prev,
        search: {
          open: !!cur.open,
          query: cur.query ?? "",
          scope,
        },
      };
    });
  }

  function openSearchHit(hit: { tabId?: string; snippetMatch?: string }) {
    if (!hit?.tabId) return;
    closeSessionSearch();

    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const existing = tabs.find((t) => t.id === hit.tabId);
    if (existing) {
      setActiveTab(existing.id);
      if (typeof hit.snippetMatch === "string" && hit.snippetMatch.length > 0) {
        const id = existing.id;
        const match = hit.snippetMatch;
        setState((prev) => {
          const cur =
            (prev.scrollToMatchByTab as Record<string, string> | undefined) ??
            {};
          return {
            ...prev,
            scrollToMatchByTab: { ...cur, [id]: match },
          };
        });
        window.setTimeout(() => {
          setState((prev) => {
            const cur =
              (prev.scrollToMatchByTab as Record<string, string> | undefined) ??
              {};
            if (!(id in cur)) return prev;
            const next = { ...cur };
            delete next[id];
            return { ...prev, scrollToMatchByTab: next };
          });
        }, 5000);
      }
      return;
    }

    newTab(hit.tabId, undefined, {
      restoredSession: true,
      ...(typeof hit.snippetMatch === "string" && hit.snippetMatch.length > 0
        ? { scrollToMatch: hit.snippetMatch }
        : {}),
    });
  }

  return {
    toggleSessionSearch,
    closeSessionSearch,
    setSearchQuery,
    setSearchScope,
    openSearchHit,
  };
}
