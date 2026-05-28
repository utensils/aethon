import type { A2UIPayload } from "../types/a2ui";
import { defaultLayoutExtension } from "../extensions/default-layout";

/** The default-layout extension ships the boot layout payload. Components
 *  that need a "reset" target (slash commands, settings reset, the
 *  composer's empty-state click) read from here so they share a single
 *  source of truth with App's initial `layout` state. */
export const BOOT_LAYOUT: A2UIPayload = defaultLayoutExtension.layout!;

/** Per-tab notification id used by the hang-warn flow. Centralized so
 *  the producer (`useOsEdges`) and the consumer (the dismiss path in
 *  `useNotifications`) can't drift on the key format. */
export function hangWarnNotifId(tabId: string): string {
  return `ae-hang-warn:${tabId}`;
}
