import type { A2UIPayload } from "../../types/a2ui";
import type { AuthProfilesSnapshot } from "../../auth-profiles";
import { OVERVIEW_TAB_ID, type Tab } from "../../types/tab";
import { deletePointer } from "../../utils/jsonPointer";
import { deepMergeState } from "../../utils/stateMutation";
import { WORKSTATION_AREAS, workstationRows } from "../useFocus";
import { TAB_MIRROR_KEYS } from "../useTabs";
import { mirrorOverviewSurfaceToRoot } from "../tabOps/helpers";
import { contextUsageFromMessage } from "./contextUsage";
import type { ModelDescriptor, RecentSessionItem } from "./types";

export interface ReadyBridgeTab {
  id: string;
  model: string;
  cwd?: string;
  authProfileId?: string;
  contextUsage?: Record<string, unknown>;
  thinkingLevel?: string;
}

export interface ReadyStateInput {
  authProfiles: AuthProfilesSnapshot;
  baseLayout: A2UIPayload;
  bridgeTabs: ReadyBridgeTab[];
  codexFastMode?: unknown;
  extState: Record<string, unknown>;
  fallbackModel: string;
  models: ModelDescriptor[];
  projectRoot?: string;
  readyThinkingLevel?: string;
  recentSessions: RecentSessionItem[];
  shouldNormalizeWorkstationLayout: boolean;
  tabReplay: Record<string, Record<string, unknown>>;
  userDir?: string;
  willPruneKeys: string[];
}

export function isWorkstationBootLayout(layout: A2UIPayload): boolean {
  const state = layout.state as
    | { layout?: { areas?: unknown; rows?: unknown } }
    | undefined;
  const areas = state?.layout?.areas;
  return (
    Array.isArray(areas) &&
    areas.some(
      (row) => typeof row === "string" && row.includes("files-sidebar"),
    )
  );
}

function terminalHeightFromState(state: Record<string, unknown>): number {
  const panel = state.terminalPanel as { height?: unknown } | undefined;
  const height = panel?.height;
  return typeof height === "number" && Number.isFinite(height) ? height : 240;
}

export function normalizeWorkstationLayout(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const layout = (state.layout as Record<string, unknown> | undefined) ?? {};
  const terminal = state.terminal as { open?: boolean } | undefined;
  return {
    ...state,
    layout: {
      ...layout,
      rows: workstationRows(
        terminal?.open === true,
        terminalHeightFromState(state),
      ),
      areas: WORKSTATION_AREAS,
    },
  };
}

function reconcileReadyTabs(
  next: Record<string, unknown>,
  input: ReadyStateInput,
): Tab[] {
  const configuredDefaultThinkingLevel =
    typeof next.defaultThinkingLevel === "string" &&
    next.defaultThinkingLevel.length > 0
      ? next.defaultThinkingLevel
      : undefined;
  const localTabs = ((next.tabs as Tab[] | undefined) ?? []).slice();
  const dIdx = localTabs.findIndex((t) => t.id === "default");
  if (dIdx >= 0 && !localTabs[dIdx].model && input.fallbackModel) {
    localTabs[dIdx] = { ...localTabs[dIdx], model: input.fallbackModel };
  }
  for (let i = 0; i < localTabs.length; i++) {
    if (!localTabs[i].model && input.fallbackModel) {
      localTabs[i] = { ...localTabs[i], model: input.fallbackModel };
    }
  }
  for (let i = 0; i < localTabs.length; i++) {
    const bt = input.bridgeTabs.find(
      (candidate) => candidate.id === localTabs[i].id,
    );
    if (bt?.model && !localTabs[i].model) {
      localTabs[i] = { ...localTabs[i], model: bt.model };
    }
    const tabThinkingLevel = localTabs[i]?.thinkingLevel;
    const localThinkingLevel =
      typeof tabThinkingLevel === "string" && tabThinkingLevel.length > 0
        ? tabThinkingLevel
        : undefined;
    const readyThinkingLevel =
      localThinkingLevel ?? configuredDefaultThinkingLevel ?? bt?.thinkingLevel;
    if (readyThinkingLevel) {
      localTabs[i] = { ...localTabs[i], thinkingLevel: readyThinkingLevel };
    }
    if (bt?.cwd && !localTabs[i].cwd) {
      localTabs[i] = { ...localTabs[i], cwd: bt.cwd };
    }
    if (bt?.authProfileId) {
      localTabs[i] = { ...localTabs[i], authProfileId: bt.authProfileId };
    }
    const contextUsage = bt?.contextUsage
      ? contextUsageFromMessage(bt.contextUsage)
      : null;
    if (contextUsage) {
      localTabs[i] = { ...localTabs[i], contextUsage };
    }
  }
  for (let i = 0; i < localTabs.length; i++) {
    const replay = input.tabReplay[localTabs[i].id];
    if (!replay) continue;
    const merged = { ...localTabs[i] } as Record<string, unknown>;
    for (const [k, v] of Object.entries(replay)) {
      if (
        merged[k] === undefined ||
        merged[k] === null ||
        (Array.isArray(merged[k]) && (merged[k] as unknown[]).length === 0) ||
        merged[k] === ""
      ) {
        merged[k] = v;
      }
    }
    localTabs[i] = merged as unknown as Tab;
  }
  return localTabs;
}

export function reduceReadyState(
  prev: Record<string, unknown>,
  input: ReadyStateInput,
): Record<string, unknown> {
  // Three-layer hydration in priority order (lowest -> highest):
  //   1. extension layout state as defaults
  //   2. extension setState patches
  //   3. ready-owned runtime fields
  let next: Record<string, unknown> = { ...prev };
  for (const stale of input.willPruneKeys) {
    next = deletePointer(next, stale);
  }
  const layoutDefaults =
    input.baseLayout &&
    typeof input.baseLayout === "object" &&
    "state" in input.baseLayout
      ? input.baseLayout.state
      : undefined;
  if (layoutDefaults) {
    next = deepMergeState(layoutDefaults, next);
  }
  next = deepMergeState(next, input.extState);
  if (input.shouldNormalizeWorkstationLayout) {
    // Older persisted snapshots and project-owned layout state had no
    // dedicated tabs row. Normalize the boot workstation grid after defaults
    // merge so stale /layout/areas cannot keep the tab strip auto-placed.
    next = normalizeWorkstationLayout(next);
  }

  // Ready enriches local tabs only. Bridge-global tab lists must not create
  // visible records inside a project-scoped UI bucket.
  next.tabs = reconcileReadyTabs(next, input);

  const activeId = (next.activeTabId as string | undefined) ?? "default";
  const tabsList = (next.tabs as Tab[] | undefined) ?? [];
  const activeTab = tabsList.find((t) => t.id === activeId);
  const overviewOwnsSurface =
    activeId === OVERVIEW_TAB_ID || !activeTab || activeTab.kind === "shell";
  const overviewMirror: Record<string, unknown> = {};
  const overviewModel = overviewOwnsSurface
    ? mirrorOverviewSurfaceToRoot(overviewMirror, next)
    : "";
  const overviewThinkingLevel =
    typeof overviewMirror.thinkingLevel === "string"
      ? overviewMirror.thinkingLevel
      : undefined;
  const activeModel = overviewOwnsSurface
    ? overviewModel || input.fallbackModel
    : activeTab.model || input.fallbackModel;
  const activeThinkingLevel = overviewOwnsSurface
    ? (overviewThinkingLevel ?? input.readyThinkingLevel)
    : activeTab.thinkingLevel || input.readyThinkingLevel;
  const existingDefaultThinkingLevel =
    typeof next.defaultThinkingLevel === "string" &&
    next.defaultThinkingLevel.length > 0
      ? next.defaultThinkingLevel
      : undefined;
  const activeTurnBusy =
    activeTab?.waiting === true ||
    (activeTab?.queueCount ?? 0) > 0 ||
    next.waiting === true ||
    ((next.queueCount as number | undefined) ?? 0) > 0;

  next = {
    ...next,
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    ...(input.userDir ? { aethonRoot: input.userDir } : {}),
    model: activeModel,
    ...(activeThinkingLevel ? { thinkingLevel: activeThinkingLevel } : {}),
    defaultThinkingLevel: existingDefaultThinkingLevel ?? activeThinkingLevel,
    codexFastMode:
      typeof input.codexFastMode === "boolean"
        ? input.codexFastMode
        : next.codexFastMode,
    status: activeTurnBusy ? "thinking…" : "ready",
    connection: "connected",
    recentSessions: input.recentSessions,
    authProfiles: input.authProfiles,
    sidebar: {
      ...(next.sidebar ?? {}),
      models: input.models.map((m) => ({
        id: m.id,
        label: m.label,
        active: m.id === activeModel,
        ...(m.thinkingLevels ? { thinkingLevels: m.thinkingLevels } : {}),
        ...(m.codexFastModeSupported ? { codexFastModeSupported: true } : {}),
      })),
    },
  };

  if (activeTab && !overviewOwnsSurface) {
    const tabRec = activeTab as unknown as Record<string, unknown>;
    for (const key of TAB_MIRROR_KEYS) {
      next[key as string] = tabRec[key as string];
    }
  } else if (overviewOwnsSurface) {
    mirrorOverviewSurfaceToRoot(next, next);
  }
  return next;
}
