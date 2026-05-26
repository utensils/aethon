// Worktree-removal UX prompts. Kept as window.confirm / window.alert
// to preserve existing behavior; the host renderer does not yet have a
// confirm-dialog wired through useNotifications for these flows. A
// follow-up issue tracks swapping to the project's notification +
// AskUserConfirm pattern.

export function alertCannotRemoveMain(): void {
  window.alert("Cannot remove the main worktree");
}

export function confirmRemoveWorktree(label: string): boolean {
  return window.confirm(`Remove worktree '${label}'?`);
}

export function confirmForceRemove(message: string): boolean {
  return window.confirm(
    `${message}\n\nForce-remove anyway? Uncommitted changes will be lost.`,
  );
}

export function confirmOrphanCleanup(): boolean {
  return window.confirm(
    `Aethon has this worktree but git no longer tracks it. ` +
      `Remove the leftover folder and forget the entry?`,
  );
}

export function alertFailure(message: string): void {
  window.alert(`Failed: ${message}`);
}
