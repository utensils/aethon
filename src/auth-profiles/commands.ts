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
