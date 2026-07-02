import { useSyncExternalStore } from "react";

import { gateway, type GatewayStatus, type HelloOk } from "./transport";

/** React binding for the transport's connection status — drives the
 *  "disconnected" banner and any connection-gated chrome. */
export function useGatewayStatus(): GatewayStatus {
  const idle: GatewayStatus = "idle";
  return useSyncExternalStore(
    (onChange) => gateway.subscribeStatus(onChange),
    () => gateway.getStatus(),
    () => idle,
  );
}

/** The paired host's identity from the last successful handshake. */
export function useGatewayHost(): HelloOk | null {
  return useSyncExternalStore(
    (onChange) => gateway.subscribeStatus(onChange),
    () => gateway.getHello(),
    () => null,
  );
}
