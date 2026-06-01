import { useRef } from "react";
import type { NotificationInput } from "./useNotifications";

export interface UseWorktreePromptsContext {
  pushNotification: (input: NotificationInput) => void;
}

export interface WorktreePromptActions {
  hasPendingWorktreePrompt: (id: string) => boolean;
  resolveWorktreePrompt: (id: string, allowed: boolean) => void;
  promptRemoveWorktree: (label: string) => Promise<boolean>;
  promptForceRemove: (message: string) => Promise<boolean>;
  promptOrphanCleanup: () => Promise<boolean>;
  notifyCannotRemoveMain: () => void;
  notifyFailure: (message: string) => void;
}

function idFor(kind: string): string {
  return `worktree-confirm-${kind}-${crypto.randomUUID().slice(0, 8)}`;
}

export function useWorktreePrompts(
  ctx: UseWorktreePromptsContext,
): WorktreePromptActions {
  const pendingRef = useRef<Map<string, (allowed: boolean) => void>>(
    new Map(),
  );

  function hasPendingWorktreePrompt(id: string): boolean {
    return pendingRef.current.has(id);
  }

  function resolveWorktreePrompt(id: string, allowed: boolean): void {
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
          { label: input.allowLabel, action: `worktree-confirm-allow:${id}` },
          { label: "Cancel", action: `worktree-confirm-deny:${id}` },
        ],
      });
    });
  }

  function promptRemoveWorktree(label: string): Promise<boolean> {
    return promptConfirm({
      kind: "remove",
      title: "Remove worktree?",
      message: `"${label}" will be removed from disk and from Aethon.`,
      allowLabel: "Remove",
    });
  }

  function promptForceRemove(message: string): Promise<boolean> {
    return promptConfirm({
      kind: "force",
      title: "Force-remove worktree?",
      message,
      allowLabel: "Force remove",
    });
  }

  function promptOrphanCleanup(): Promise<boolean> {
    return promptConfirm({
      kind: "orphan",
      title: "Forget orphaned worktree?",
      message:
        "Aethon has this worktree but git no longer tracks it. Remove the leftover folder and forget the entry?",
      allowLabel: "Remove leftover",
    });
  }

  function notifyCannotRemoveMain(): void {
    ctx.pushNotification({
      title: "Cannot remove main worktree",
      kind: "warning",
    });
  }

  function notifyFailure(message: string): void {
    ctx.pushNotification({
      title: "Worktree removal failed",
      message,
      kind: "error",
    });
  }

  return {
    hasPendingWorktreePrompt,
    resolveWorktreePrompt,
    promptRemoveWorktree,
    promptForceRemove,
    promptOrphanCleanup,
    notifyCannotRemoveMain,
    notifyFailure,
  };
}
