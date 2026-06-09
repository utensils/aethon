import { useRef } from "react";
import type { NotificationInput } from "./useNotifications";

export interface UseWorkspacePromptsContext {
  pushNotification: (input: NotificationInput) => void;
}

export interface WorkspacePromptActions {
  hasPendingWorkspacePrompt: (id: string) => boolean;
  resolveWorkspacePrompt: (id: string, allowed: boolean) => void;
  promptRemoveWorkspace: (label: string) => Promise<boolean>;
  promptForceRemove: (message: string) => Promise<boolean>;
  promptOrphanCleanup: () => Promise<boolean>;
  notifyCannotRemoveMain: () => void;
  notifyFailure: (message: string) => void;
}

function idFor(kind: string): string {
  return `workspace-confirm-${kind}-${crypto.randomUUID().slice(0, 8)}`;
}

export function useWorkspacePrompts(
  ctx: UseWorkspacePromptsContext,
): WorkspacePromptActions {
  const pendingRef = useRef<Map<string, (allowed: boolean) => void>>(
    new Map(),
  );

  function hasPendingWorkspacePrompt(id: string): boolean {
    return pendingRef.current.has(id);
  }

  function resolveWorkspacePrompt(id: string, allowed: boolean): void {
    const resolve = pendingRef.current.get(id);
    if (!resolve) return;
    pendingRef.current.delete(id);
    resolve(allowed);
  }

  function promptConfirm(input: {
    kind: string;
    title: string;
    message: string;
    allowLabel: string;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      const id = idFor(input.kind);
      pendingRef.current.set(id, resolve);
      ctx.pushNotification({
        id,
        title: input.title,
        message: input.message,
        kind: "warning",
        durationMs: null,
        actions: [
          { label: input.allowLabel, action: `workspace-confirm-allow:${id}` },
          { label: "Cancel", action: `workspace-confirm-deny:${id}` },
        ],
      });
    });
  }

  function promptRemoveWorkspace(label: string): Promise<boolean> {
    return promptConfirm({
      kind: "remove",
      title: "Remove workspace?",
      message: `"${label}" will be removed from disk and from Aethon.`,
      allowLabel: "Remove",
    });
  }

  function promptForceRemove(message: string): Promise<boolean> {
    return promptConfirm({
      kind: "force",
      title: "Force-remove workspace?",
      message,
      allowLabel: "Force remove",
    });
  }

  function promptOrphanCleanup(): Promise<boolean> {
    return promptConfirm({
      kind: "orphan",
      title: "Forget orphaned workspace?",
      message:
        "Aethon has this workspace but git no longer tracks it. Remove the leftover folder and forget the entry?",
      allowLabel: "Remove leftover",
    });
  }

  function notifyCannotRemoveMain(): void {
    ctx.pushNotification({
      title: "Cannot remove main workspace",
      kind: "warning",
    });
  }

  function notifyFailure(message: string): void {
    ctx.pushNotification({
      title: "Workspace removal failed",
      message,
      kind: "error",
    });
  }

  return {
    hasPendingWorkspacePrompt,
    resolveWorkspacePrompt,
    promptRemoveWorkspace,
    promptForceRemove,
    promptOrphanCleanup,
    notifyCannotRemoveMain,
    notifyFailure,
  };
}
