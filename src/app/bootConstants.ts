import type { A2UIPayload } from "../types/a2ui";
import { defaultLayoutExtension } from "../extensions/default-layout";
import mobilePayload from "../mobile/mobile.a2ui.json";

/** The boot layout payload. Components that need a "reset" target (slash
 *  commands, settings reset, the composer's empty-state click) read from
 *  here so they share a single source of truth with App's initial
 *  `layout` state. The mobile surface boots the touch-first single-column
 *  layout; the desktop boots the workstation. `VITE_AETHON_SURFACE` is a
 *  build-time define, so the unused branch is tree-shaken per bundle. */
export const BOOT_LAYOUT: A2UIPayload =
  import.meta.env.VITE_AETHON_SURFACE === "mobile"
    ? mobilePayload
    : defaultLayoutExtension.layout!;

/** Per-tab notification id used by the hang-warn flow. Centralized so
 *  the producer (`useOsEdges`) and the consumer (the dismiss path in
 *  `useNotifications`) can't drift on the key format. */
export function hangWarnNotifId(tabId: string): string {
  return `ae-hang-warn:${tabId}`;
}
