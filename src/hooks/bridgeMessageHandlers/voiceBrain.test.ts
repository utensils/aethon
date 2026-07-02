// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleVoiceBrainDelta,
  handleVoiceBrainEnd,
  handleVoiceBrainError,
} from "./voiceBrain";
import {
  onVoiceBrainDelta,
  onVoiceBrainEnd,
  onVoiceBrainError,
} from "../../utils/voiceBrainEvents";
import type { BridgeMessageContext } from "./types";

const ctx = {} as BridgeMessageContext;
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
});

describe("voice brain bridge handlers", () => {
  it("fans deltas out as window events", () => {
    const seen = vi.fn();
    cleanups.push(onVoiceBrainDelta(seen));
    handleVoiceBrainDelta({ type: "voice_brain_delta", text: "hi" }, ctx);
    handleVoiceBrainDelta({ type: "voice_brain_delta", text: "" }, ctx);
    handleVoiceBrainDelta({ type: "voice_brain_delta" }, ctx);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ text: "hi" });
  });

  it("fans end out with an optional dispatched task", () => {
    const seen = vi.fn();
    cleanups.push(onVoiceBrainEnd(seen));
    handleVoiceBrainEnd(
      {
        type: "voice_brain_end",
        text: "On it.",
        dispatched: { tabId: "tab-1", label: "fix tests" },
      },
      ctx,
    );
    handleVoiceBrainEnd({ type: "voice_brain_end", text: "plain" }, ctx);
    expect(seen).toHaveBeenNthCalledWith(1, {
      text: "On it.",
      dispatched: { tabId: "tab-1", label: "fix tests" },
    });
    expect(seen).toHaveBeenNthCalledWith(2, { text: "plain" });
  });

  it("fans errors out with a fallback message", () => {
    const seen = vi.fn();
    cleanups.push(onVoiceBrainError(seen));
    handleVoiceBrainError({ type: "voice_brain_error", message: "boom" }, ctx);
    handleVoiceBrainError({ type: "voice_brain_error" }, ctx);
    expect(seen).toHaveBeenNthCalledWith(1, { message: "boom" });
    expect(seen).toHaveBeenNthCalledWith(2, {
      message: "The voice assistant failed to reply",
    });
  });
});
