import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTauriMocks, clearTauriMocks } from "../test/tauriMocks";
import {
  cancelVoiceRecording,
  listVoiceProviders,
  prepareVoiceProvider,
  removeVoiceProviderModel,
  setSelectedVoiceProvider,
  setVoiceProviderEnabled,
  speakVoice,
  startVoiceRecording,
  stopAndTranscribeVoice,
  stopVoicePlayback,
} from "./voice";

describe("voice service", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  it("invokes provider list without extra payload", async () => {
    harness.invoke.mockResolvedValueOnce([]);

    await expect(listVoiceProviders()).resolves.toEqual([]);

    expect(harness.invoke).toHaveBeenCalledWith("voice_list_providers");
  });

  it("speaks text and stops playback", async () => {
    await speakVoice("hello world");
    await stopVoicePlayback();

    expect(harness.invoke).toHaveBeenNthCalledWith(1, "voice_speak", {
      text: "hello world",
    });
    expect(harness.invoke).toHaveBeenNthCalledWith(2, "voice_stop_playback");
  });

  it("serializes selected and enabled provider mutations", async () => {
    await setSelectedVoiceProvider("voice-distil-whisper");
    await setSelectedVoiceProvider(null);
    await setVoiceProviderEnabled("voice-platform-system", false);

    expect(harness.invoke).toHaveBeenNthCalledWith(
      1,
      "voice_set_selected_provider",
      { providerId: "voice-distil-whisper" },
    );
    expect(harness.invoke).toHaveBeenNthCalledWith(
      2,
      "voice_set_selected_provider",
      { providerId: null },
    );
    expect(harness.invoke).toHaveBeenNthCalledWith(
      3,
      "voice_set_provider_enabled",
      { providerId: "voice-platform-system", enabled: false },
    );
  });

  it("serializes setup and model removal actions", async () => {
    await prepareVoiceProvider("voice-distil-whisper");
    await removeVoiceProviderModel("voice-distil-whisper");

    expect(harness.invoke).toHaveBeenNthCalledWith(
      1,
      "voice_prepare_provider",
      { providerId: "voice-distil-whisper" },
    );
    expect(harness.invoke).toHaveBeenNthCalledWith(
      2,
      "voice_remove_provider_model",
      { providerId: "voice-distil-whisper" },
    );
  });

  it("passes null provider ids for default recording commands", async () => {
    harness.invoke.mockResolvedValueOnce(undefined);
    harness.invoke.mockResolvedValueOnce("hello");
    harness.invoke.mockResolvedValueOnce(undefined);

    await startVoiceRecording();
    await expect(stopAndTranscribeVoice()).resolves.toBe("hello");
    await cancelVoiceRecording();

    expect(harness.invoke).toHaveBeenNthCalledWith(
      1,
      "voice_start_recording",
      { providerId: null },
    );
    expect(harness.invoke).toHaveBeenNthCalledWith(
      2,
      "voice_stop_and_transcribe",
      { providerId: null },
    );
    expect(harness.invoke).toHaveBeenNthCalledWith(
      3,
      "voice_cancel_recording",
      { providerId: null },
    );
  });

  it("passes explicit provider ids for recording commands", async () => {
    await startVoiceRecording("voice-platform-system");
    await stopAndTranscribeVoice("voice-platform-system");
    await cancelVoiceRecording("voice-platform-system");

    expect(harness.invoke).toHaveBeenNthCalledWith(
      1,
      "voice_start_recording",
      { providerId: "voice-platform-system" },
    );
    expect(harness.invoke).toHaveBeenNthCalledWith(
      2,
      "voice_stop_and_transcribe",
      { providerId: "voice-platform-system" },
    );
    expect(harness.invoke).toHaveBeenNthCalledWith(
      3,
      "voice_cancel_recording",
      { providerId: "voice-platform-system" },
    );
  });
});
