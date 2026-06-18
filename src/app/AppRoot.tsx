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

/** App-root render. The four overlays mount through `RegistryComponent`
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
  chromeReady,
  startupLogoUrl,
  workspaceStartup,
  onStartupApprove,
  onStartupRetry,
  onStartupContinue,
  topBanner,
}: AppRootProps) {
  const showStartupOverlay =
    chromeReady &&
    workspaceStartup?.entry &&
    ["running", "approval_required", "failed"].includes(
      workspaceStartup.entry.state,
    );
  return (
    <ExtensionRegistryProvider registry={registry}>
      {/* `data-platform="mac"` gates the overlay-titlebar chrome (traffic-
          light clearance + drag regions) so non-mac builds render unchanged. */}
      <div className="app" {...(isMacOS() ? { "data-platform": "mac" } : {})}>
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
            startup={workspaceStartup}
            onApprove={onStartupApprove}
            onRetry={onStartupRetry}
            onContinue={onStartupContinue}
          />
        )}
        {showStartupOverlay ? (
          <StartupCurtain
            logoUrl={startupLogoUrl}
            startup={workspaceStartup}
            onApprove={onStartupApprove}
            onRetry={onStartupRetry}
            onContinue={onStartupContinue}
          />
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
      </div>
    </ExtensionRegistryProvider>
  );
}
