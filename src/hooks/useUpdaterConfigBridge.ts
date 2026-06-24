import { useMemo } from "react";
import type { AethonConfig } from "../config";

export interface UseUpdaterConfigBridgeContext {
  reapplyConfig: (fresh: AethonConfig) => void;
  setUpdateChannel: (channel: AethonConfig["updates"]["channel"]) => void;
  setUpdateDisableAutoCheck: (
    disabled: AethonConfig["updates"]["disableAutoCheck"],
  ) => void;
}

export function useUpdaterConfigBridge({
  reapplyConfig,
  setUpdateChannel,
  setUpdateDisableAutoCheck,
}: UseUpdaterConfigBridgeContext): (fresh: AethonConfig) => void {
  return useMemo(
    () => (fresh: AethonConfig) => {
      reapplyConfig(fresh);
      setUpdateChannel(fresh.updates.channel);
      setUpdateDisableAutoCheck(fresh.updates.disableAutoCheck);
    },
    [reapplyConfig, setUpdateChannel, setUpdateDisableAutoCheck],
  );
}
