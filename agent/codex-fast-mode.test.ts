import { describe, expect, it, vi } from "vitest";
import type { Model } from "@mariozechner/pi-ai";
import type { AethonAgentState } from "./state";
import {
  applyCodexModeToPayload,
  applyCodexFastModeToPayload,
  installCodexFastModePayloadHook,
  supportsCodexFastMode,
} from "./codex-fast-mode";

function model(provider: string, id: string): Model<never> {
  return { provider, id, name: id } as unknown as Model<never>;
}

describe("Codex Fast mode", () => {
  it("is only supported for documented Codex models", () => {
    expect(supportsCodexFastMode(model("openai-codex", "gpt-5.5"))).toBe(true);
    expect(supportsCodexFastMode(model("openai-codex", "gpt-5.4"))).toBe(true);
    expect(supportsCodexFastMode(model("openai-codex", "gpt-5.6-sol"))).toBe(
      true,
    );
    expect(supportsCodexFastMode(model("openai-codex", "gpt-5.3-codex"))).toBe(
      false,
    );
    expect(supportsCodexFastMode(model("openai", "gpt-5.5"))).toBe(false);
  });

  it("patches Agent payload and stream option paths for priority service tier", async () => {
    const state = { codexFastMode: true } as AethonAgentState;
    const codexModel = model("openai-codex", "gpt-5.5");
    const streamFn = vi.fn(() => Promise.resolve("stream"));
    const agent = {
      onPayload: vi.fn((payload: unknown) => Promise.resolve(payload)),
      streamFn,
    };

    installCodexFastModePayloadHook(state, {
      model: codexModel,
      agent,
    });

    await expect(agent.onPayload({ model: "gpt-5.5" })).resolves.toEqual({
      model: "gpt-5.5",
      service_tier: "priority",
    });
    await agent.streamFn(codexModel, {}, { timeoutMs: 1000 });
    expect(streamFn).toHaveBeenCalledWith(
      codexModel,
      {},
      {
        timeoutMs: 1000,
        serviceTier: "priority",
      },
    );
  });

  it("adds priority service_tier only when enabled and supported", () => {
    const payload = { model: "gpt-5.5", input: [] };
    expect(
      applyCodexFastModeToPayload(
        payload,
        true,
        model("openai-codex", "gpt-5.5"),
      ),
    ).toEqual({ model: "gpt-5.5", input: [], service_tier: "priority" });
    expect(
      applyCodexFastModeToPayload(
        payload,
        false,
        model("openai-codex", "gpt-5.5"),
      ),
    ).toBe(payload);
    expect(
      applyCodexFastModeToPayload(payload, true, model("openai", "gpt-5.5")),
    ).toBe(payload);
  });

  it("sends GPT-5.6 Max and Ultra as distinct Codex efforts", () => {
    const sol = model("openai-codex", "gpt-5.6-sol");
    expect(applyCodexModeToPayload({}, false, "max", sol)).toEqual({
      reasoning: { effort: "max" },
    });
    expect(
      applyCodexModeToPayload(
        { reasoning: { effort: "xhigh", summary: "auto" } },
        false,
        "ultra",
        sol,
      ),
    ).toEqual({ reasoning: { effort: "ultra", summary: "auto" } });
    expect(
      applyCodexModeToPayload(
        {},
        false,
        "ultra",
        model("openai-codex", "gpt-5.5"),
      ),
    ).toEqual({});
  });
});
