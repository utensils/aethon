import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { A2UIPayload } from "../../types/a2ui";
import {
  builtinLayouts,
  type LayoutCatalogueEntry,
} from "../../extensions/default-layout";
import { deepMergeState } from "../../utils/stateMutation";
import type { SlashCommand } from "../../slashCommands";

export function summarizeLayoutComponents(payload: A2UIPayload): {
  id: string;
  label: string;
  active: boolean;
}[] {
  const types = new Set<string>();
  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    const n = node as {
      type?: string;
      children?: unknown[];
      components?: unknown[];
    };
    if (typeof n.type === "string") types.add(n.type);
    if (Array.isArray(n.children)) n.children.forEach(walk);
    if (Array.isArray(n.components)) n.components.forEach(walk);
  }
  walk(payload);
  return [...types]
    .sort()
    .map((t) => ({ id: `c-${t}`, label: t, active: true }));
}

export interface LayoutActionsDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  setLayout: Dispatch<SetStateAction<A2UIPayload>>;
  layoutCatalogueRef: MutableRefObject<LayoutCatalogueEntry[]>;
  slashCommandsRef: MutableRefObject<SlashCommand[]>;
  layout: A2UIPayload;
}

export function useLayoutActions(deps: LayoutActionsDeps) {
  const { setState, setLayout, layoutCatalogueRef, slashCommandsRef, layout } =
    deps;

  /** Refresh /sidebar/components whenever the layout changes so any
   *  extension-registered inspector reflects what's actually rendered. */
  useEffect(() => {
    const list = summarizeLayoutComponents(layout);
    setState((prev) => {
      const sidebar =
        (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      return { ...prev, sidebar: { ...sidebar, components: list } };
    });
  }, [layout, setState]);

  /** Surface the slash command list + layout catalogue into layout state
   *  so the chat-input autocomplete can resolve via $ref. Done once on
   *  mount; subsequent updates flow through hydrateSlashCommands /
   *  hydrateExtensionLayouts. */
  useEffect(() => {
    setState((prev) => {
      const sidebar =
        (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      const activeLayoutId = (() => {
        const list =
          (sidebar.layouts as { id: string; active?: boolean }[] | undefined) ??
          [];
        return (
          list.find((l) => l.active)?.id ?? layoutCatalogueRef.current[0]?.id
        );
      })();
      const catalogueItems = layoutCatalogueRef.current.map((l) => ({
        id: l.id,
        label: l.id,
        active: l.id === activeLayoutId,
      }));
      return {
        ...prev,
        slashCommands: slashCommandsRef.current.map((c) => ({
          name: c.name,
          description: c.description,
          usage: c.usage,
          argSource: c.argSource,
        })),
        layoutCatalogue: layoutCatalogueRef.current.map((l) => ({
          id: l.id,
          label: l.name,
          description: l.description,
        })),
        sidebar: { ...sidebar, layouts: catalogueItems },
      };
    });
    // Mount-only seed — we explicitly don't want to re-run on setState
    // identity churn since this is a layout-prime, not a sync effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Layout activation — single path used by both
   *  `window.aethon.activateLayout` and the `/layout` slash command.
   *  Seeds layout state defaults for keys absent from current app state
   *  (live state wins on collisions) and rebuilds /sidebar/layouts. */
  function activateLayoutById(id: string): boolean {
    const entry = layoutCatalogueRef.current.find((l) => l.id === id);
    if (!entry) return false;
    setLayout(entry.payload);
    const seeds = entry.payload.state ?? {};
    const catalogueItems = layoutCatalogueRef.current.map((l) => ({
      id: l.id,
      label: l.id,
      active: l.id === id,
    }));
    setState((prev) => {
      const seeded =
        seeds && Object.keys(seeds).length > 0
          ? deepMergeState(seeds, prev)
          : { ...prev };
      // The new layout's `columns` seed is authoritative — different
      // layouts may have different grid SHAPES, and deepMergeState keeps
      // prev's columns, which would mean a 2-col grid carrying a
      // 3-col-only cell has nowhere to render. So force-take the seed's
      // columns, then patch the leading sidebar token with the user's
      // persisted width so cross-layout resizing feels continuous.
      const seedLayout =
        (seeds.layout as Record<string, unknown> | undefined) ?? {};
      const prevLayout =
        (prev.layout as Record<string, unknown> | undefined) ?? {};
      const seedCols = (seedLayout.columns as string | undefined) ?? "";
      const prevCols = (prevLayout.columns as string | undefined) ?? "";
      let nextCols = seedCols;
      if (seedCols && prevCols) {
        const seedTokens = seedCols.trim().split(/\s+/);
        const prevTokens = prevCols.trim().split(/\s+/);
        if (seedTokens.length > 0 && prevTokens[0]?.endsWith("px")) {
          seedTokens[0] = prevTokens[0];
          nextCols = seedTokens.join(" ");
        }
      }
      const seededLayout =
        (seeded.layout as Record<string, unknown> | undefined) ?? {};
      seeded.layout = nextCols
        ? { ...seededLayout, columns: nextCols }
        : seededLayout;
      const sidebar =
        (seeded.sidebar as Record<string, unknown> | undefined) ?? {};
      seeded.sidebar = { ...sidebar, layouts: catalogueItems };
      return seeded;
    });
    return true;
  }

  function hydrateExtensionLayouts(
    list: {
      id: string;
      name: string;
      description?: string;
      payload: A2UIPayload;
    }[],
  ) {
    const builtinIds = new Set(builtinLayouts.map((l) => l.id));
    const surviving = layoutCatalogueRef.current.filter((l) =>
      builtinIds.has(l.id),
    );
    const incoming = list
      .filter(
        (l) => !builtinIds.has(l.id) && typeof l.id === "string" && l.payload,
      )
      .map((l) => ({
        id: l.id,
        name: l.name,
        description: l.description,
        payload: l.payload,
      }));
    layoutCatalogueRef.current = [...surviving, ...incoming];
    setState((prev) => {
      const sidebar =
        (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      const prevLayoutItems =
        (sidebar.layouts as { id: string; active?: boolean }[] | undefined) ??
        [];
      const activeId =
        prevLayoutItems.find((l) => l.active)?.id ??
        layoutCatalogueRef.current[0]?.id;
      const catalogueItems = layoutCatalogueRef.current.map((l) => ({
        id: l.id,
        label: l.id,
        active: l.id === activeId,
      }));
      return {
        ...prev,
        layoutCatalogue: layoutCatalogueRef.current.map((l) => ({
          id: l.id,
          label: l.name,
          description: l.description,
        })),
        sidebar: { ...sidebar, layouts: catalogueItems },
      };
    });
  }

  return { activateLayoutById, hydrateExtensionLayouts };
}
