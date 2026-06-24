import type { Tab } from "../../types/tab";
import { activeCwd, type ProjectsState } from "../../projects";
import type { DiscoveredSession } from "./types";
import { recomputeModelPicker } from "../../utils/modelPicker";

/** Tab-strip label for a bridge-discovered persistent session. Prefers
 *  an explicit `customLabel` from the bridge, then the first user
 *  message (whitespace-collapsed), then a synthetic `Session <prefix>`.
 *  Truncation is the bridge's responsibility — pi already trims long
 *  first-message previews. */
export function sessionLabel(session: DiscoveredSession): string {
  if (session.customLabel) return session.customLabel;
  if (session.firstUserMessage) {
    return session.firstUserMessage.replace(/\s+/g, " ").trim();
  }
  return `Session ${session.tabId.slice(0, 8)}`;
}

/** Derive a friendly tab label from the first user message in the tab's
 *  chat history. Returns undefined when there's no user message yet so
 *  the caller can fall back to the synthetic `Tab N` label. Truncates at
 *  48 characters with an ellipsis. */
export function sessionLabelFromMessages(
  messages: Tab["messages"],
): string | undefined {
  const first = messages.find(
    (m) =>
      m.role === "user" &&
      typeof m.text === "string" &&
      m.text.trim().length > 0,
  );
  const text = first?.text?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 48 ? `${text.slice(0, 47)}...` : text;
}

/** Resolve the model id a freshly-opened tab should inherit. Falls
 *  through: explicit per-launch override → the user's chosen default
 *  (`/defaultModel`, set by the header picker / Settings and persisted to
 *  `[agent] model`) → legacy per-project memory → pi's ready-reported
 *  default. `/defaultModel` deliberately wins over per-project memory so a
 *  header pick is respected by *every* new session, not just sessions in
 *  projects that have never run an agent. Trimmed because user-typed model
 *  ids occasionally carry trailing whitespace. */
export function modelForNewProjectTab(
  state: Record<string, unknown>,
  activeProjectId: string | null,
  fallbackModel: string,
  explicitModel?: string,
): string {
  const projectModels =
    (state.projectModels as Record<string, string> | undefined) ?? {};
  const projectModel = activeProjectId ? projectModels[activeProjectId] : "";
  return (
    (explicitModel ?? "") ||
    (state.defaultModel as string | undefined) ||
    projectModel ||
    fallbackModel
  ).trim();
}

export function activeProjectIdForModelDefaults(
  state: Record<string, unknown>,
): string | null {
  const project = state.project as { id?: unknown } | null | undefined;
  if (typeof project?.id === "string" && project.id.length > 0) {
    return project.id;
  }
  return typeof state.activeProjectId === "string" &&
    state.activeProjectId.length > 0
    ? state.activeProjectId
    : null;
}

/** Model displayed by overview-owned surfaces. Shell tabs can be the
 *  active tab for terminal focus, but the overview still owns the composer
 *  and header in that state, so the visible model must be the model a new
 *  task would inherit rather than stale shell metadata. */
export function modelForOverviewSurface(
  state: Record<string, unknown>,
): string {
  const piDefaultModel =
    typeof state.piDefaultModel === "string" ? state.piDefaultModel : "";
  return modelForNewProjectTab(
    state,
    activeProjectIdForModelDefaults(state),
    piDefaultModel,
  );
}

export function thinkingLevelForOverviewSurface(
  state: Record<string, unknown>,
): string | undefined {
  return typeof state.defaultThinkingLevel === "string"
    ? state.defaultThinkingLevel
    : undefined;
}

export function mirrorOverviewSurfaceToRoot(
  result: Record<string, unknown>,
  sourceState: Record<string, unknown>,
): string {
  const overviewModel = modelForOverviewSurface(sourceState);
  const overviewThinkingLevel = thinkingLevelForOverviewSurface(sourceState);
  if (overviewModel) {
    result.model = overviewModel;
  }
  if (overviewThinkingLevel) {
    result.thinkingLevel = overviewThinkingLevel;
  } else {
    delete result.thinkingLevel;
  }
  return overviewModel;
}

export function mirrorOverviewSurfaceSelection(
  result: Record<string, unknown>,
  sourceState: Record<string, unknown>,
): string {
  const overviewModel = mirrorOverviewSurfaceToRoot(result, sourceState);
  result.sidebar = recomputeModelPicker(
    sourceState.sidebar as Record<string, unknown> | undefined,
    overviewModel,
  );
  return overviewModel;
}

/** Resolve the cwd a freshly-opened tab should inherit. Active project
 *  wins; when no project is selected, the host workspace is rooted in
 *  Aethon's user dir. The dev-only `projectRoot` is only a last-resort
 *  fallback when the user dir is unavailable. */
export function cwdForNewTab(
  projects: ProjectsState,
  appState: Record<string, unknown>,
): string | null {
  const projectCwd = activeCwd(projects);
  if (projectCwd) return projectCwd;
  const aethonRoot = appState.aethonRoot;
  if (typeof aethonRoot === "string" && aethonRoot.length > 0) {
    return aethonRoot;
  }
  const projectRoot = appState.projectRoot;
  return typeof projectRoot === "string" && projectRoot.length > 0
    ? projectRoot
    : null;
}

/** Project a closed agent tab into a `recentSessions` entry so the
 *  empty-state's history list can offer to restore it. Returns null
 *  for non-agent tabs and for empty conversations (nothing to label). */
export function recentSessionItemFromClosedTab(
  tab: Tab,
  projects: ProjectsState,
): { id: string; label: string; lastModified: string; cwd?: string } | null {
  if (tab.kind !== "agent" || tab.messages.length === 0) return null;
  const fallbackProjectPath = tab.projectId
    ? projects.projects.find((p) => p.id === tab.projectId)?.path
    : undefined;
  const cwd = tab.cwd ?? fallbackProjectPath;
  return {
    id: tab.id,
    label: sessionLabelFromMessages(tab.messages) ?? tab.label,
    lastModified: "now",
    ...(cwd ? { cwd } : {}),
  };
}

/** Compute an editor tab's label from its absolute path: just the
 *  basename, since the full path is shown in the editor status strip.
 *  Handles both POSIX and Windows separators because the underlying
 *  paths come from native Tauri commands. */
export function editorLabelForPath(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slash >= 0 ? filePath.slice(slash + 1) : filePath;
}
