import { invoke } from "@tauri-apps/api/core";
import { isAgentTabInFlight } from "../utils/agentBusy";
import { OVERVIEW_TAB_ID, type Tab } from "../types/tab";

export interface AccountSwitchTarget {
  /** Tab the switch should target. Overview / non-agent / missing tabs
   *  collapse to `"default"` (the global account path) so we never spawn a
   *  worker for a session that doesn't exist. */
  tabId: string;
  cwd?: string;
  model?: string;
  /** True when the resolved tab is mid-prompt; callers must not switch
   *  (the global + worker states would diverge — see switchAccountForTab). */
  busy: boolean;
}

/** Resolve the target + busy state for an account switch from the active
 *  tab. Shared by the Accounts panel and the header selector. */
export function resolveAccountSwitchTarget(
  tabs: Tab[],
  activeTabId: string | undefined,
): AccountSwitchTarget {
  const tab = tabs.find(
    (t) =>
      t.id === activeTabId &&
      t.id !== OVERVIEW_TAB_ID &&
      (t.kind ?? "agent") === "agent",
  );
  if (!tab) return { tabId: "default", busy: false };
  return {
    tabId: tab.id,
    cwd: tab.cwd,
    model: tab.model,
    busy: isAgentTabInFlight(tab),
  };
}

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
 * Set the default account for a profile's provider. This is the account new
 * tabs/tasks inherit (a fresh tab with no explicit binding resolves its
 * account from `defaultByProvider` via the bridge's `defaultProfileIdForTab`).
 * Used by the header account selector when no live agent tab is active (the
 * overview), where there's no session to rebind — picking an account means
 * "use this for new work on this provider".
 */
export async function setDefaultAccount(profileId: string): Promise<void> {
  if (!profileId) return;
  await sendAuthProfileCommand({
    type: "auth_profile_set_default",
    profileId,
  });
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
