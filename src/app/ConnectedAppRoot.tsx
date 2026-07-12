import type { ComponentProps } from "react";
import type { AppStore } from "../state/appStore";
import { useAppState } from "../state/appStore";
import type { Tab } from "../types/tab";
import { useDerivedRenderState } from "../hooks/useDerivedRenderState";
import type { UseHostInfo } from "../hooks/useHostInfo";
import { AppRoot } from "./AppRoot";

type RootProps = ComponentProps<typeof AppRoot>;

interface ConnectedAppRootProps
  extends Omit<
    RootProps,
    | "renderState"
    | "activeTabId"
    | "notificationsOpen"
    | "paletteOpen"
    | "settingsOpen"
    | "searchOpen"
    | "authProfilesOpen"
    | "scheduledTasksOpen"
  > {
  appStore: AppStore;
  buildSidebarHistory: (
    tabs: Tab[],
    activeTabId: string | undefined,
    recentSessions: Array<{
      id: string;
      label: string;
      lastModified?: string;
      cwd?: string;
    }>,
  ) => Array<{
    id: string;
    label: string;
    hint?: string;
    tooltip?: string;
    active?: boolean;
  }>;
  hostInfo: UseHostInfo;
}

/** Render-only store subscriber. High-frequency canvas, message, terminal,
 * and draft updates stop at this boundary instead of rerunning App's process,
 * persistence, project, and bridge hook graph. */
export function ConnectedAppRoot({
  appStore,
  buildSidebarHistory,
  hostInfo,
  ...rootProps
}: ConnectedAppRootProps) {
  const state = useAppState(appStore, (value) => value);
  const {
    renderState,
    notificationsOpen,
    paletteOpen,
    settingsOpen,
    searchOpen,
    authProfilesOpen,
    scheduledTasksOpen,
  } = useDerivedRenderState({ state, buildSidebarHistory, hostInfo });

  return (
    <AppRoot
      {...rootProps}
      renderState={renderState}
      activeTabId={state.activeTabId as string | undefined}
      notificationsOpen={notificationsOpen}
      paletteOpen={paletteOpen}
      settingsOpen={settingsOpen}
      searchOpen={searchOpen}
      authProfilesOpen={authProfilesOpen}
      scheduledTasksOpen={scheduledTasksOpen}
    />
  );
}
