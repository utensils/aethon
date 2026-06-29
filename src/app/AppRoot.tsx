import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import A2UIRenderer, {
  RegistryComponent,
  type A2UIEventHandler,
} from "../components/A2UIRenderer";
import { ExtensionRegistryProvider } from "../extensions/ExtensionRegistryProvider";
import type { ExtensionRegistry } from "../extensions/ExtensionRegistry";
import type { A2UIPayload } from "../types/a2ui";
import { isMacOS } from "../utils/platform";
import { StartupCurtain } from "./StartupCurtain";
import type { WorkspaceStartupView } from "../hooks/useWorkspaceStartup";

const WORKSPACE_STARTUP_HOST_SELECTOR =
  '.a2ui-layout-cell[data-slot="canvas"][data-visible="true"]';

function readWorkspaceStartupHost(active: boolean): HTMLElement | null {
  if (!active || typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(WORKSPACE_STARTUP_HOST_SELECTOR);
}

function subscribeWorkspaceStartupHost(onStoreChange: () => void): () => void {
  if (
    typeof document === "undefined" ||
    !document.body ||
    typeof MutationObserver === "undefined"
  ) {
    return () => {};
  }

  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-area", "data-visible"],
    childList: true,
    subtree: true,
  });
  queueMicrotask(onStoreChange);

  return () => observer.disconnect();
}

function WorkspaceStartupPortal({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const host = useSyncExternalStore(
    subscribeWorkspaceStartupHost,
    () => readWorkspaceStartupHost(active),
    () => null,
  );

  if (!active || !host) return null;
  return createPortal(
    <div className="ae-workspace-startup-host">{children}</div>,
    host,
  );
}

export interface AppRootProps {
  registry: ExtensionRegistry;
  layout: A2UIPayload;
  renderState: Record<string, unknown>;
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  onEvent: A2UIEventHandler;
  activeTabId: string | undefined;
  notificationsOpen: boolean;
  paletteOpen: boolean;
  settingsOpen: boolean;
  searchOpen: boolean;
  authProfilesOpen: boolean;
  scheduledTasksOpen: boolean;
  chromeReady: boolean;
  startupLogoUrl: string;
  workspaceStartup?: WorkspaceStartupView | null;
  onStartupApprove?: () => void;
  onStartupRetry?: () => void;
  onStartupContinue?: () => void;
  /** Optional banner row rendered above the layout. Sits in flow as the
   *  first flex child of `.app` so it pushes the rest of the chrome
   *  down instead of floating over it. */
  topBanner?: ReactNode;
}

/** App-root render. Root overlays mount through `RegistryComponent`
 *  so an extension can swap each with `aethon.registerComponent("<type>",
 *  custom)`. Each overlay still gates its own visibility on state
 *  (e.g. /commandPalette/open) — the boolean flags here just keep the
 *  closed overlay tree out of the DOM. `tabId` is forwarded so extension
 *  override templates route their bridge events against the active pi
 *  session. */
export function AppRoot({
  registry,
  layout,
  renderState,
  setState,
  onEvent,
  activeTabId,
  notificationsOpen,
  paletteOpen,
  settingsOpen,
  searchOpen,
  authProfilesOpen,
  scheduledTasksOpen,
  chromeReady,
  startupLogoUrl,
  workspaceStartup,
  onStartupApprove,
  onStartupRetry,
  onStartupContinue,
  topBanner,
}: AppRootProps) {
  const showStartupOverlay = Boolean(
    chromeReady &&
      workspaceStartup?.entry &&
      ["running", "approval_required", "failed"].includes(
        workspaceStartup.entry.state,
      ),
  );
  const sidebarCollapsed =
    (renderState.layout as { sidebarVisible?: unknown } | undefined)
      ?.sidebarVisible === false;
  return (
    <ExtensionRegistryProvider registry={registry}>
      {/* `data-platform="mac"` gates the overlay-titlebar chrome (traffic-
          light clearance + drag regions) so non-mac builds render unchanged. */}
      <div
        className="app"
        {...(isMacOS() ? { "data-platform": "mac" } : {})}
        {...(sidebarCollapsed
          ? { "data-sidebar-collapsed": "true" }
          : {})}
      >
        {chromeReady ? topBanner : null}
        {chromeReady ? (
          <A2UIRenderer
            payload={layout}
            state={renderState}
            onStateChange={setState}
            onEvent={onEvent}
            tabId={activeTabId}
          />
        ) : (
          <StartupCurtain
            logoUrl={startupLogoUrl}
            onApprove={onStartupApprove}
            onRetry={onStartupRetry}
            onContinue={onStartupContinue}
          />
        )}
        {showStartupOverlay ? (
          <WorkspaceStartupPortal active={showStartupOverlay}>
            <StartupCurtain
              logoUrl={startupLogoUrl}
              startup={workspaceStartup}
              scope="workspace"
              onApprove={onStartupApprove}
              onRetry={onStartupRetry}
              onContinue={onStartupContinue}
            />
          </WorkspaceStartupPortal>
        ) : null}
        {chromeReady && notificationsOpen && (
          <RegistryComponent
            type="notification-stack"
            state={renderState}
            onEvent={onEvent}
            tabId={activeTabId}
          />
        )}
        {chromeReady && paletteOpen && (
          <RegistryComponent
            type="command-palette"
            state={renderState}
            onEvent={onEvent}
            tabId={activeTabId}
          />
        )}
        {chromeReady && settingsOpen && (
          <RegistryComponent
            type="settings-panel"
            state={renderState}
            onEvent={onEvent}
            tabId={activeTabId}
          />
        )}
        {chromeReady && searchOpen && (
          <RegistryComponent
            type="search-panel"
            state={renderState}
            onEvent={onEvent}
            tabId={activeTabId}
          />
        )}
        {chromeReady && authProfilesOpen && (
          <RegistryComponent
            type="auth-profile-panel"
            state={renderState}
            onEvent={onEvent}
            tabId={activeTabId}
          />
        )}
        {chromeReady && scheduledTasksOpen && (
          <RegistryComponent
            type="scheduled-tasks-panel"
            state={renderState}
            onEvent={onEvent}
            tabId={activeTabId}
          />
        )}
      </div>
    </ExtensionRegistryProvider>
  );
}
