import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MutableRefObject } from "react";
import type { Tab } from "../types/tab";

interface UseRestoreShellTabsOptions {
  tabs: Tab[];
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
  appendSystem: (text: string) => void;
  shellInheritEnvRef: MutableRefObject<boolean>;
}

export function useRestoreShellTabs({
  tabs,
  updateTab,
  appendSystem,
  shellInheritEnvRef,
}: UseRestoreShellTabsOptions): void {
  const attemptedRef = useRef(new Set<string>());

  useEffect(() => {
    const markRestored = (tabId: string) => {
      updateTab(tabId, (t) => {
        if (!t.shell) return t;
        const shell = { ...t.shell };
        delete shell.restartOnMount;
        return { ...t, shell: { ...shell, shellState: "running" } };
      });
    };

    for (const tab of tabs) {
      if (tab.kind !== "shell" || !tab.shell?.restartOnMount) continue;
      if (attemptedRef.current.has(tab.id)) continue;
      attemptedRef.current.add(tab.id);

      const shell = tab.shell;
      invoke("shell_open", {
        args: {
          tabId: tab.id,
          ...(shell.command ? { command: shell.command } : {}),
          ...(shell.args.length > 0 ? { args: shell.args } : {}),
          ...(shell.cwd ? { cwd: shell.cwd } : {}),
          ...(shell.shareMode !== "private"
            ? { shareMode: shell.shareMode }
            : {}),
          ...(shellInheritEnvRef.current === false ? { inheritEnv: false } : {}),
        },
      })
        .then(() => {
          markRestored(tab.id);
        })
        .catch((err: unknown) => {
          const message = String(err);
          if (message.includes("shell already open for tab")) {
            markRestored(tab.id);
            return;
          }
          appendSystem(`Failed to restore shell tab: ${message}`);
          updateTab(tab.id, (t) => {
            if (!t.shell) return t;
            const shell = { ...t.shell };
            delete shell.restartOnMount;
            return {
              ...t,
              shell: { ...shell, shellState: "exited", exitCode: -1 },
            };
          });
        });
    }
  }, [appendSystem, shellInheritEnvRef, tabs, updateTab]);
}
