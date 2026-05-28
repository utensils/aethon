import type { Dispatch, ReactNode, SetStateAction } from "react";
import A2UIRenderer, {
  RegistryComponent,
  type A2UIEventHandler,
} from "../components/A2UIRenderer";
import { ExtensionRegistryProvider } from "../extensions/ExtensionRegistryProvider";
import type { ExtensionRegistry } from "../extensions/ExtensionRegistry";
import type { A2UIPayload } from "../types/a2ui";

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
  topBanner,
}: AppRootProps) {
  return (
    <ExtensionRegistryProvider registry={registry}>
      <div className="app">
        {topBanner}
        <A2UIRenderer
          payload={layout}
          state={renderState}
          onStateChange={setState}
          onEvent={onEvent}
          tabId={activeTabId}
        />
        {notificationsOpen && (
          <RegistryComponent
            type="notification-stack"
            state={renderState}
            onEvent={onEvent}
            tabId={activeTabId}
          />
        )}
        {paletteOpen && (
          <RegistryComponent
            type="command-palette"
            state={renderState}
            onEvent={onEvent}
            tabId={activeTabId}
          />
        )}
        {settingsOpen && (
          <RegistryComponent
            type="settings-panel"
            state={renderState}
            onEvent={onEvent}
            tabId={activeTabId}
          />
        )}
        {searchOpen && (
          <RegistryComponent
            type="search-panel"
            state={renderState}
            onEvent={onEvent}
            tabId={activeTabId}
          />
        )}
        {authProfilesOpen && (
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
