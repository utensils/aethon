import { invoke } from "@tauri-apps/api/core";

import { remoteHostInvoke } from "./services/remote";

export function isRemoteHostId(
  hostId: string | null | undefined,
): hostId is string {
  return typeof hostId === "string" && hostId.startsWith("remote:");
}

export function invokeForHost<T = unknown>(
  hostId: string | null | undefined,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return isRemoteHostId(hostId)
    ? remoteHostInvoke<T>(hostId, cmd, args ?? {})
    : args === undefined
      ? invoke<T>(cmd)
      : invoke<T>(cmd, args);
}
