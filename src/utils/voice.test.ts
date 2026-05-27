import { describe, expect, it } from "vitest";
import type { VoiceProviderInfo } from "../types/voice";
import {
  PLATFORM_VOICE_PROVIDER_ID,
  chooseVoiceProvider,
  describeSpeechRecognitionError,
  insertTranscriptAtSelection,
  shouldOpenVoiceSettingsForError,
} from "./voice";

function provider(
  overrides: Partial<VoiceProviderInfo> & Pick<VoiceProviderInfo, "id">,
): VoiceProviderInfo {
  return {
    name: overrides.id,
    description: "",
    kind: "platform",
    recordingMode: "native",
    privacyLabel: "",
    offline: false,
    downloadRequired: false,
    modelSizeLabel: null,
    cachePath: null,
    acceleratorLabel: null,
    status: "ready",
    statusLabel: "Ready",
    enabled: true,
    selected: false,
    setupRequired: false,
    canRemoveModel: false,
    error: null,
    ...overrides,
    id: overrides.id,
  };
}

describe("voice helpers", () => {
  it("prefers the selected ready provider", () => {
    const selected = provider({
      id: "voice-platform-system",
      selected: true,
    });

    expect(
      chooseVoiceProvider([
        provider({ id: "voice-distil-whisper", kind: "local-model" }),
        selected,
      ]),
    ).toBe(selected);
  });

  it("falls back to ready local model before platform provider", () => {
    const local = provider({
      id: "voice-distil-whisper",
      kind: "local-model",
    });

    expect(
      chooseVoiceProvider([
        provider({ id: PLATFORM_VOICE_PROVIDER_ID }),
        local,
      ]),
    ).toBe(local);
  });

  it("returns setup-required providers when nothing is ready", () => {
    const setup = provider({
      id: PLATFORM_VOICE_PROVIDER_ID,
      status: "needs-setup",
      setupRequired: true,
    });

    expect(chooseVoiceProvider([setup])).toBe(setup);
  });

  it("inserts transcripts at textarea selection with natural spacing", () => {
    expect(insertTranscriptAtSelection("run now", "tests", 3, 3)).toEqual({
      text: "run tests now",
      cursor: 9,
    });
    expect(insertTranscriptAtSelection("run now", "tests", 0, 3)).toEqual({
      text: "tests now",
      cursor: 5,
    });
  });

  it("opens settings for setup and engine errors", () => {
    expect(
      shouldOpenVoiceSettingsForError(
        provider({ id: PLATFORM_VOICE_PROVIDER_ID, setupRequired: true }),
      ),
    ).toBe(true);
    expect(
      shouldOpenVoiceSettingsForError(
        provider({ id: "voice-distil-whisper", status: "engine-unavailable" }),
      ),
    ).toBe(true);
    expect(shouldOpenVoiceSettingsForError(provider({ id: "ready" }))).toBe(
      false,
    );
  });

  it("describes common speech recognition errors in plain English", () => {
    expect(
      describeSpeechRecognitionError({ error: "not-allowed" }),
    ).toContain("Microphone and Speech Recognition permission");
    expect(describeSpeechRecognitionError({ error: "no-speech" })).toContain(
      "No speech was detected",
    );
    expect(describeSpeechRecognitionError({ message: "boom" })).toBe(
      "System dictation failed: boom",
    );
  });
});
