import { invoke } from "@tauri-apps/api/core";

export async function sendAuthProfileCommand(
  payload: Record<string, unknown>,
): Promise<void> {
  await invoke("agent_command", {
    payload: JSON.stringify(payload),
  });
}

export async function requestAuthProfiles(): Promise<void> {
  await sendAuthProfileCommand({ type: "auth_profiles_list" });
}

/**
 * Switch the active account for a tab. The global bridge owns the auth
 * surface (`auth_profile_use_for_tab`), but a non-default tab runs its
 * prompts in a separate worker bridge that must also rebuild its session
 * against the new account — otherwise the worker keeps using the old
 * (possibly rate-limited) account. For non-default tabs we relay a
 * tab-scoped `auth_profile_apply` so the worker re-auths too.
 *
 * Pass the tab's `cwd` and `model` so the relay carries them: if the worker
 * was idle-retired (or never spawned), `auth_profile_apply` is what spawns
 * it, and without the cwd/model the rebuilt session falls back to the wrong
 * workspace (tools in the wrong directory) and the default model (silently
 * changing the tab's model).
 *
 * Shared by the Accounts panel and the header account selector so both
 * entry points stay in sync.
 */
export async function switchAccountForTab(
  tabId: string,
  profileId: string,
  opts: { cwd?: string; model?: string } = {},
): Promise<void> {
  await sendAuthProfileCommand({
    type: "auth_profile_use_for_tab",
    tabId,
    profileId,
  });
  if (tabId && tabId !== "default") {
    await sendAuthProfileCommand({
      type: "auth_profile_apply",
      tabId,
      profileId,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    });
  }
}
