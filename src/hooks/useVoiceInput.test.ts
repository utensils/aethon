// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceProviderInfo } from "../types/voice";
import { useVoiceInput } from "./useVoiceInput";

const service = vi.hoisted(() => ({
  listVoiceProviders: vi.fn(),
  startVoiceRecording: vi.fn(),
  stopAndTranscribeVoice: vi.fn(),
  cancelVoiceRecording: vi.fn(),
}));

vi.mock("../services/voice", () => service);

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
    selected: true,
    setupRequired: false,
    canRemoveModel: false,
    error: null,
    ...overrides,
    id: overrides.id,
  };
}

describe("useVoiceInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.listVoiceProviders.mockResolvedValue([
      provider({ id: "voice-platform-system" }),
    ]);
    service.startVoiceRecording.mockResolvedValue(undefined);
    service.stopAndTranscribeVoice.mockResolvedValue("hello world");
    service.cancelVoiceRecording.mockResolvedValue(undefined);
  });

  it("starts and stops a native provider, inserting the final transcript", async () => {
    const onTranscript = vi.fn();
    const onNeedsSetup = vi.fn();
    const { result } = renderHook(() =>
      useVoiceInput(onTranscript, onNeedsSetup),
    );

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe("recording");
    expect(service.startVoiceRecording).toHaveBeenCalledWith(
      "voice-platform-system",
    );

    act(() => {
      result.current.stop();
    });

    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(service.stopAndTranscribeVoice).toHaveBeenCalledWith(
      "voice-platform-system",
    );
    expect(onTranscript).toHaveBeenCalledWith("hello world", {
      autoSend: false,
    });
  });

  it("forwards the autoSend intent captured at start to the transcript", async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript, vi.fn()));

    await act(async () => {
      await result.current.start({ autoSend: true });
    });
    act(() => {
      result.current.stop();
    });

    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(onTranscript).toHaveBeenCalledWith("hello world", {
      autoSend: true,
    });
  });

  it("routes setup-required native providers to settings", async () => {
    service.listVoiceProviders.mockResolvedValueOnce([
      provider({
        id: "voice-platform-system",
        status: "needs-setup",
        selected: true,
        setupRequired: true,
        statusLabel: "Permission required",
      }),
    ]);
    service.startVoiceRecording.mockRejectedValueOnce("permission denied");
    const onNeedsSetup = vi.fn();
    const { result } = renderHook(() => useVoiceInput(vi.fn(), onNeedsSetup));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe("setup-required");
    expect(onNeedsSetup).toHaveBeenCalledWith("voice-platform-system");
    expect(service.startVoiceRecording).toHaveBeenCalledWith(
      "voice-platform-system",
    );
  });

  it("cancels an active native recording", async () => {
    const { result } = renderHook(() => useVoiceInput(vi.fn(), vi.fn()));

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      result.current.cancel();
    });

    expect(result.current.state).toBe("idle");
    expect(service.cancelVoiceRecording).toHaveBeenCalledWith(
      "voice-platform-system",
    );
  });
});
