import { invoke } from "@tauri-apps/api/core";

/** Mirrors `VoiceConvoStatus` in src-tauri/src/commands/voice_convo.rs. */
export interface VoiceConvoStatus {
  available: boolean;
  state:
    | "idle"
    | "listening"
    | "user-speaking"
    | "awaiting-brain"
    | "speaking";
  /** Resolved provider per stage (what a conversation would actually use). */
  sttProvider: string;
  ttsProvider: string;
  /** Why a stage can't run, when it can't. */
  sttError: string | null;
  ttsError: string | null;
  deepgramKeyPresent: boolean;
  cartesiaKeyPresent: boolean;
  lastError: string | null;
}

export function voiceConvoStatus(): Promise<VoiceConvoStatus> {
  return invoke("voice_convo_status");
}

export function startVoiceConvo(): Promise<void> {
  return invoke("voice_convo_start");
}

export function stopVoiceConvo(): Promise<void> {
  return invoke("voice_convo_stop");
}

export function speakConvoChunk(text: string): Promise<void> {
  return invoke("voice_convo_speak_chunk", { text });
}

export function endConvoSpeech(): Promise<void> {
  return invoke("voice_convo_speak_end");
}

export function cancelConvoSpeech(): Promise<void> {
  return invoke("voice_convo_cancel_speech");
}

export function forceConvoEndTurn(): Promise<void> {
  return invoke("voice_convo_force_end_turn");
}

export interface VoiceConvoProviderTest {
  deepgramOk: boolean;
  deepgramError: string | null;
  cartesiaOk: boolean;
  cartesiaError: string | null;
}

/** Prove each cascade provider key opens a real session (connect + close). */
export function testConvoProviders(): Promise<VoiceConvoProviderTest> {
  return invoke("voice_convo_test_providers");
}

export interface CartesiaVoice {
  id: string;
  name: string;
}

export function listConvoVoices(): Promise<CartesiaVoice[]> {
  return invoke("voice_convo_list_voices");
}

/** Fire-and-forget a voice-brain message to the global bridge (same
 *  `agent_command` path useDevshell uses for devshell_event). Voice types are
 *  not tab-scoped in the Rust router, so these always reach the global
 *  bridge; tab references ride inside the payload as activeTabId/taskTabId. */
export function sendVoiceBridgeMessage(
  payload: Record<string, unknown>,
): void {
  void invoke("agent_command", { payload: JSON.stringify(payload) }).catch(
    () => {
      /* agent not booted yet — the conversation surfaces its own errors */
    },
  );
}
